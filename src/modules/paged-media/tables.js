import Handler from "../handler.js";

export const TABLE_BREAK_END_CLASS = "break-end-token";
export const ADDED_CELL_CLASS = "added-cell";
export const EMPTY_CELL_CLASS = "empty-cell";

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
		// remove added break end elements and empty cells
		const elemsToRemove = [
			...page.area.querySelectorAll(`.${TABLE_BREAK_END_CLASS}`),
		];
		for (const toRemove of elemsToRemove) {
			toRemove.remove();
		}

		const addedCells = [
			...page.area.querySelectorAll(`td.${ADDED_CELL_CLASS}`),
		];
		// check and remove duplicated cell
		for (const cell of addedCells) {
			const existingCell = page.area.querySelector(
				`td[data-ref="${cell.dataset.ref}"]:not(.${ADDED_CELL_CLASS})`
			);
			if (existingCell) {
				cell.remove();
			}
		}
		const mainContainer = page.area.querySelector("main");
		if (mainContainer) {
			const tables = mainContainer.querySelectorAll("table");
			for (const table of tables) {
				this.fixTableRows(table);
			}

			const previousPageMainContainer =
				pageElement.previousElementSibling?.querySelector(
					".pagedjs_area > .pagedjs_page_content > div main"
				);
			if (previousPageMainContainer) {
				// remove duplicated table rows
				const previousPageLastElementTable =
					previousPageMainContainer.querySelector(
						":scope > div[data-type='clause']:last-child > div[data-type='variant']:last-child > div:last-child > table,\
					:scope > div[data-type='clause']:last-child > div[data-type='variant']:last-child > table:last-child,\
					:scope > div:last-child > table,\
					:scope > table:last-child"
					);

				if (previousPageLastElementTable) {
					const allLastPreviousPageRow = [
						...previousPageLastElementTable.querySelectorAll(
							"tbody tr:last-child"
						),
					];

					for (const lastPreviousPageRow of allLastPreviousPageRow) {
						const currentRow = mainContainer.querySelector(
							`tbody tr[data-ref="${lastPreviousPageRow.dataset.ref}"]`
						);

						if (currentRow && this.isTableRowEmpty(lastPreviousPageRow)) {
							// remove last row from previous page as it is duplicated
							const previousTBody = lastPreviousPageRow.parentNode;
							lastPreviousPageRow.remove();
							if (previousTBody.childNodes.length === 0) {
								previousPageLastElementTable.remove();
							}
						} else if (
							currentRow &&
							currentRow.childElementCount === 1 &&
							currentRow.querySelector("td:empty")
						) {
							currentRow.firstElementChild.style.backgroundColor = "pink";
						}
						// else if (
						// 	mainContainer.querySelectorAll("table")[1]?.dataset.ref ===
						// 	previousPageLastElementTable.dataset.ref
						// ) {
						// 	previousPageLastElementTable.remove();
						// }
					}
				}
			}

			const lastElementTable = mainContainer.querySelector(
				":scope > div[data-type='clause']:last-child > div[data-type='variant']:last-child > div:last-child > table,\
				:scope > div[data-type='clause']:last-child > div[data-type='variant']:last-child > table:last-child,\
				:scope > div:last-child > table,\
				:scope > table:last-child"
			);
			if (lastElementTable) {
				page.area.style.columnWidth = "auto"; // show the table even if it is overflowing
			}
		}
	}

	isTableRowEmpty(row) {
		for (let idx = 0; idx < row.childNodes.length; ++idx) {
			if (!isTableCellEmpty(row.childNodes[idx])) {
				return false;
			}
		}
		return true;
	}

	setTableCellsSizeData(table) {
		const cellsPosData = [];
		const rows = [...table.querySelectorAll(":scope > tbody > tr")];
		const maxCells = Math.max(
			...(rows.length > 0
				? rows.map((row) =>
					[...row.querySelectorAll(":scope > td")]
						.map((td) =>
							td.hasAttribute("colspan")
								? parseInt(td.getAttribute("colspan") ?? 1, 10)
								: 1
						)
						.reduce((sum, nb) => sum + nb, 0)
				)
				: [0])
		);
		const mapPosData =
			maxCells !== -Infinity
				? rows.map(() => Array(maxCells).fill(undefined))
				: [];

		for (let rowIdx = 0; rowIdx < rows.length; ++rowIdx) {
			const row = rows[rowIdx];
			const cols = row.querySelectorAll(":scope > td");
			if (cols.length === 0) continue;

			for (let colIdx = 0; colIdx < cols.length; ++colIdx) {
				const posDataIdx = mapPosData[rowIdx]?.findIndex(
					(d) => d === undefined
				);
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

	fixTableRows(table) {
		const bigCells = table.querySelectorAll(
			"td[rowspan]:not([rowspan='1'])"
		);

		if (bigCells.length === 0) return;
		// tag empty cells
		const singleCells = table.querySelectorAll("td[rowspan='1'],td:not([rowspan])");
		for (const cell of singleCells) {
			if (isTableCellEmpty(cell)) {
				cell.classList.add(EMPTY_CELL_CLASS);
			}
		}
		// move big cells from empty rows
		const bigCellRows = [...new Set([...bigCells].map(cell => cell.parentNode))];
		for (let idx = 0; idx < bigCellRows.length; ++idx) {
			const row = bigCellRows[idx];
			const nextRow = row.nextElementSibling;
			if (nextRow?.tagName === "TR" && 
				!row.querySelector(`td[rowspan='1']:not(.${EMPTY_CELL_CLASS}),td:not([rowspan]):not(.${EMPTY_CELL_CLASS})`)) {
				// line with empty cells and cell with rowspan > 1, move big cells to next row
				const rowBigCells = [...row.querySelectorAll("td[rowspan]:not([rowspan='1'])")];
				
				for (const bigCell of rowBigCells) {
					const bigCellX = parseInt(bigCell.dataset.xStart);
					for (let cellIdx = 0; cellIdx < nextRow.childElementCount; ++cellIdx) {
						const cell = nextRow.children[cellIdx];
						if (bigCellX < (parseInt(cell.dataset.xStart) || 1)) {
							nextRow.insertBefore(bigCell, cell);
							bigCell.setAttribute("rowspan", parseInt(bigCell.getAttribute("rowspan")) - 1);
							break;
						}
					}
					if (bigCellRows[idx + 1] !== nextRow) {
						bigCellRows.splice(idx + 1, 0, nextRow);
					}
				}
				row.remove();
			}
		}
	}
}

export const DomElementsWithSize = ["img", "table", "br", "wbr", "hr"];

export function isTableCellEmpty(cell) {
	const cellContent = cell.textContent.trim();

	// Check if the cell contains only whitespace or is empty
	if (cellContent !== "" && cellContent !== "\u00A0") {
		return false;
	}

	const elementWithSize = cell.querySelector(DomElementsWithSize.join(","));
	if (elementWithSize) {
		return false;
	}

	for (let idx; idx < cell.childNodes.length; ++idx) {
		if (cell.childNodes[idx].offsetHeight > 0) {
			return false;
		}
	}
	return true;
}

export default Tables;
