import Handler from "../handler.js";

class Tables extends Handler {
	constructor(chunker, polisher, caller) {
		super(chunker, polisher, caller);
	}

	afterParsed(parsed) {
		const tables = parsed.querySelectorAll("table");
		tables.forEach((table) => {
			this.setTableCellsSizeData(table);
		});
	}

	afterPageLayout(pageElement, page, breakToken) {
		const addedCells = [...page.area.querySelectorAll("td.added")];
		// check and remove duplicated cell
		for (const cell of addedCells) {
			const existingCell = page.area.querySelector(`td[data-ref="${cell.dataset.ref}"]:not(.added)`);
			if (existingCell) {
				cell.remove();
			}
		}
		const mainContainer = page.area.querySelector("main");
		if (mainContainer) {
			const lastElementTable = mainContainer.querySelector(":scope > div[data-type=\"clause\"]:last-child > div[data-type=\"variant\"]:last-child > div:last-child > table, :scope > div[data-type=\"clause\"]:last-child > div[data-type=\"variant\"]:last-child > table:last-child, :scope > div:last-child > table, :scope > table:last-child");

			if (lastElementTable) {
				page.area.style.columnWidth = "auto"; // show the content that slicely "overflowing"
			}

			const previousPageMainContainer = pageElement.previousElementSibling?.querySelector(".pagedjs_area > .pagedjs_page_content > div main");

			if (previousPageMainContainer) {
				const previousPageLastElementTable = previousPageMainContainer.querySelector(":scope > div[data-type=\"clause\"]:last-child > div[data-type=\"variant\"]:last-child > div:last-child > table, :scope > div[data-type=\"clause\"]:last-child > div[data-type=\"variant\"]:last-child > table:last-child, :scope > div:last-child > table, :scope > table:last-child");

				if (previousPageLastElementTable) {
					const currentPageSameFirstTable = mainContainer.querySelector(`:scope > div[data-type="clause"]:first-child > div[data-type="variant"]:first-child > div:first-child > table[data-ref="${previousPageLastElementTable.dataset.ref}"], :scope > div[data-type="clause"]:first-child > div[data-type="variant"]:first-child > table[data-ref="${previousPageLastElementTable.dataset.ref}"]:first-child, :scope > div:first-child > table[data-ref="${previousPageLastElementTable.dataset.ref}"], :scope > table[data-ref="${previousPageLastElementTable.dataset.ref}"]:first-child`);
					let lastPreviousPageRow;

					if (currentPageSameFirstTable && (lastPreviousPageRow = previousPageLastElementTable.querySelector("tbody tr:last-child")) && currentPageSameFirstTable.querySelector(`tbody tr[data-ref="${lastPreviousPageRow.dataset.ref}"]:nth-child(2)`)) {
						// remove last row from previous page as it is overflowing and duplicated
						lastPreviousPageRow.remove();
					}
				}
			}
		}
	}

	setTableCellsSizeData(table) {
		const cellsPosData = [];
		const rows = [...table.querySelectorAll(":scope > tbody > tr")];
		const maxCells = Math.max(
			...(rows.length > 0
				? rows.map((row) => row.querySelectorAll(":scope > td").length || 0)
				: [0])
		);
		const mapPosData =
			maxCells !== -Infinity
				? rows.map(() => Array(maxCells).fill(undefined))
				: [];
	
		for (let rowIdx = 0; rowIdx < rows.length; ++rowIdx) {
			const row = rows[rowIdx];
			const cols = row.querySelectorAll(":scope > td");
			if (!cols) continue;
	
			for (let colIdx = 0; colIdx < cols.length; ++colIdx) {
				const posDataIdx = mapPosData[rowIdx]?.findIndex((d) => d === undefined);
				const cell = cols[colIdx];
				const rowSpan = cell.getAttribute("rowspan")
					? parseInt(cell.getAttribute("rowspan"), 10) ?? 1
					: 1;
				const colSpan = cell.getAttribute("colspan")
					? parseInt(cell.getAttribute("colspan"), 10) ?? 1
					: 1;
				for (let spanIdx = 0; spanIdx < rowSpan; ++spanIdx) {
					const rowPos = rowIdx + spanIdx;
	
					mapPosData[rowPos].fill(
						spanIdx === 0 ? colIdx : "x",
						posDataIdx,
						posDataIdx + colSpan
					);
				}

				cell.setAttribute("data-x-start", posDataIdx);
				cell.setAttribute("data-x-end", posDataIdx + (colSpan - 1));
				cell.setAttribute("data-y-start", rowIdx);
				cell.setAttribute("data-y-end", rowIdx + (rowSpan - 1));
			}
		}
		return cellsPosData;
	}	
}

export default Tables;
