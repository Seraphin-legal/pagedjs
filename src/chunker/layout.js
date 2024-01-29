import { UUID, getBoundingClientRect, getClientRects } from "../utils/utils.js";
import {
	breakInsideAvoidParentNode,
	child,
	cloneNode,
	findElement,
	hasContent,
	indexOf,
	indexOfTextNode,
	isContainer,
	isElement,
	isText,
	letters,
	needsBreakBefore,
	needsPageBreak,
	needsPreviousBreakAfter,
	nodeAfter,
	nodeBefore,
	parentOf,
	nextCellSiblingWithContent,
	prevValidNode,
	rebuildAncestors,
	validNode,
	walk,
	words,
	getAllNextTableCells,
	isFirstChild,
	isLastTableCell,
} from "../utils/dom.js";
import BreakToken from "./breaktoken.js";
import RenderResult, { OverflowContentError } from "./renderresult.js";
import EventEmitter from "event-emitter";
import Hook from "../utils/hook.js";
import {
	isTableCellEmpty,
	EMPTY_CELL_CLASS,
	TABLE_BREAK_END_CLASS,
} from "../modules/paged-media/tables.js";

export const FINDING_OVERFLOW_CLASS = "process-find-overflow";

const MAX_CHARS_PER_BREAK = 1500;

/**
 * Layout
 * @class
 */
class Layout {
	constructor(element, hooks, options) {
		this.element = element;

		this.bounds = this.element.getBoundingClientRect();
		this.parentBounds = this.element.offsetParent.getBoundingClientRect();
		let gap = parseFloat(window.getComputedStyle(this.element).columnGap);
		if (gap) {
			let leftMargin = this.bounds.left - this.parentBounds.left;
			this.gap = gap - leftMargin;
		} else {
			this.gap = 0;
		}

		if (hooks) {
			this.hooks = hooks;
		} else {
			this.hooks = {};
			this.hooks.onPageLayout = new Hook();
			this.hooks.layout = new Hook();
			this.hooks.renderNode = new Hook();
			this.hooks.layoutNode = new Hook();
			this.hooks.beforeOverflow = new Hook();
			this.hooks.onOverflow = new Hook();
			this.hooks.afterOverflowRemoved = new Hook();
			this.hooks.onBreakToken = new Hook();
			this.hooks.beforeRenderResult = new Hook();
		}

		this.settings = options || {};

		this.maxChars = this.settings.maxChars || MAX_CHARS_PER_BREAK;
		this.forceRenderBreak = false;
	}

	async renderTo(wrapper, source, breakToken, bounds = this.bounds) {
		let start = this.getStart(
			source,
			Array.isArray(breakToken) ? breakToken[0] : breakToken
		);
		const rowToResume =
			Array.isArray(breakToken) && breakToken.length > 1
				? breakToken.slice(1).map((bt) => parentOf(bt.node, "TD", source))
				: [];
		let walker = walk(start, source);

		let node;
		let prevNode;
		let done;
		let next;

		let hasRenderedContent = false;
		let newBreakToken;

		let length = 0;

		let prevBreakToken = breakToken || new BreakToken(start);

		this.hooks &&
			this.hooks.onPageLayout.trigger(wrapper, prevBreakToken, this);

		while (!done && !newBreakToken) {
			next = walker.next();
			prevNode = node;
			node = next.value;
			done = next.done;
			let resumeIdx;
			if ((resumeIdx = rowToResume.indexOf(node)) !== -1) {
				// TODO update walker
				const colBreak = breakToken[resumeIdx + 1];
				const resumeNode = this.getStart(source, colBreak);
				walker = walk(resumeNode, source);
				next = walker.next();
				prevNode = node;
				node = next.value;
				done = next.done;
			}

			if (!node) {
				this.hooks && this.hooks.layout.trigger(wrapper, this);

				let imgs = wrapper.querySelectorAll("img");
				if (imgs.length) {
					await this.waitForImages(imgs);
				}

				newBreakToken = this.findBreakToken(
					wrapper,
					source,
					bounds,
					prevBreakToken
				);

				if (
					newBreakToken &&
					!Array.isArray(newBreakToken) &&
					newBreakToken.equals(prevBreakToken)
				) {
					console.warn("Unable to layout item: ", prevNode);
					this.hooks &&
						this.hooks.beforeRenderResult.trigger(undefined, wrapper, this);
					return new RenderResult(
						undefined,
						new OverflowContentError("Unable to layout item", [prevNode])
					);
				}

				// this.rebuildTableFromBreakToken(newBreakToken, wrapper);

				this.hooks &&
					this.hooks.beforeRenderResult.trigger(newBreakToken, wrapper, this);
				return new RenderResult(newBreakToken);
			}

			this.hooks && this.hooks.layoutNode.trigger(node);

			// Check if the rendered element has a break set
			if (hasRenderedContent && this.shouldBreak(node, start)) {
				this.hooks && this.hooks.layout.trigger(wrapper, this);

				let imgs = wrapper.querySelectorAll("img");
				if (imgs.length) {
					await this.waitForImages(imgs);
				}

				newBreakToken = this.findBreakToken(
					wrapper,
					source,
					bounds,
					prevBreakToken
				);

				if (!newBreakToken) {
					newBreakToken = this.breakAt(node);
				} else {
					// this.rebuildTableFromBreakToken(newBreakToken, wrapper);
				}

				if (
					newBreakToken &&
					!Array.isArray(newBreakToken) &&
					newBreakToken.equals(prevBreakToken)
				) {
					console.warn("Unable to layout item: ", node);
					let after = newBreakToken.node && nodeAfter(newBreakToken.node);
					if (after) {
						newBreakToken = new BreakToken(after);
					} else {
						return new RenderResult(
							undefined,
							new OverflowContentError("Unable to layout item", [node])
						);
					}
				}

				length = 0;

				break;
			}

			if (node.dataset && node.dataset.page) {
				let named = node.dataset.page;
				let page = this.element.closest(".pagedjs_page");
				page.classList.add("pagedjs_named_page");
				page.classList.add("pagedjs_" + named + "_page");

				if (!node.dataset.splitFrom) {
					page.classList.add("pagedjs_" + named + "_first_page");
				}
			}

			// Should the Node be a shallow or deep clone
			let shallow = isContainer(node);

			let rendered = this.append(node, wrapper, breakToken, shallow);

			length += rendered.textContent.length;

			// Check if layout has content yet
			if (!hasRenderedContent) {
				hasRenderedContent = hasContent(node);
			}

			// Skip to the next node if a deep clone was rendered
			if (!shallow) {
				walker = walk(nodeAfter(node, source), source);
			}

			if (this.forceRenderBreak) {
				this.hooks && this.hooks.layout.trigger(wrapper, this);

				newBreakToken = this.findBreakToken(
					wrapper,
					source,
					bounds,
					prevBreakToken
				);

				if (!newBreakToken) {
					newBreakToken = this.breakAt(node);
				} else {
					// this.rebuildTableFromBreakToken(newBreakToken, wrapper);
				}

				length = 0;
				this.forceRenderBreak = false;

				break;
			}

			// Only check x characters
			if (length >= this.maxChars) {
				this.hooks && this.hooks.layout.trigger(wrapper, this);

				let imgs = wrapper.querySelectorAll("img");
				if (imgs.length) {
					await this.waitForImages(imgs);
				}

				const currentCol =
					node.tagName === "TD" ? node : parentOf(node, "TD", source);
				if (
					currentCol &&
					this.findOverflow(
						wrapper,
						bounds,
						undefined,
						source,
						prevBreakToken,
						true
					) // TODO optimize, replace findOverflow here by another function
				) {
					// add missing content in the current columns
					let cellChildIdx = currentCol.firstChild;
					while (cellChildIdx && !cellChildIdx.contains(node)) {
						cellChildIdx = cellChildIdx.nextSibling;
					}
					if (cellChildIdx?.nextSibling) {
						cellChildIdx = cellChildIdx.nextSibling;
						while (cellChildIdx) {
							this.hooks && this.hooks.layoutNode.trigger(cellChildIdx);
							this.append(cellChildIdx, wrapper, breakToken, false);
							cellChildIdx = cellChildIdx.nextSibling;
						}
					}

					// create missing cells
					const otherCellsInTable = getAllNextTableCells(currentCol, source);
					for (const nextCell of otherCellsInTable) {
						const existingCell = findElement(nextCell, wrapper, true);
						if (!existingCell || isTableCellEmpty(existingCell)) {
							const prevBreakElem = Array.isArray(breakToken)
								? breakToken.find((bt) => {
									const tableCol =
											bt.node.tagName === "TD"
												? bt.node
												: parentOf(bt.node, "TD");
									return (
										!!tableCol &&
											nextCell.dataset.ref === tableCol.dataset.ref
									);
								  })
								: null;
							if (prevBreakElem) {
								// resume the table split
								let resumeNode = this.getStart(source, prevBreakElem);
								let resumeWalker = walk(resumeNode, source);
								const currentCell =
									resumeNode.tagName === "TD"
										? resumeNode
										: parentOf(resumeNode, "TD", source);
								let nextResume = resumeWalker.next(); // skip first element
								let doneResume;

								do {
									this.hooks && this.hooks.layoutNode.trigger(resumeNode);
									this.append(resumeNode, wrapper, breakToken, true);
									nextResume = resumeWalker.next();
									resumeNode = nextResume.value;
									doneResume = nextResume.done;
								} while (
									!doneResume &&
									resumeNode &&
									resumeNode.tagName !== "TD" &&
									currentCell.contains(resumeNode)
								);
							} else {
								// duplicate column
								this.hooks && this.hooks.layoutNode.trigger(nextCell);
								this.append(
									nextCell,
									wrapper,
									breakToken,
									nextCell?.lastElementChild?.classList?.contains(
										TABLE_BREAK_END_CLASS
									)
								);
							}
						}
					}
				}

				newBreakToken = this.findBreakToken(
					wrapper,
					source,
					bounds,
					prevBreakToken
				);

				if (newBreakToken) {
					length = 0;
					// this.rebuildTableFromBreakToken(newBreakToken, wrapper);
				}

				if (
					newBreakToken &&
					!Array.isArray(newBreakToken) &&
					newBreakToken.equals(prevBreakToken)
				) {
					console.warn("Unable to layout item: ", node);
					let after = newBreakToken.node && nodeAfter(newBreakToken.node);
					if (after) {
						newBreakToken = new BreakToken(after);
					} else {
						this.hooks &&
							this.hooks.beforeRenderResult.trigger(undefined, wrapper, this);
						return new RenderResult(
							undefined,
							new OverflowContentError("Unable to layout item", [node])
						);
					}
				}
			}
		}

		this.hooks &&
			this.hooks.beforeRenderResult.trigger(newBreakToken, wrapper, this);
		return new RenderResult(newBreakToken);
	}

	breakAt(node, offset = 0) {
		let newBreakToken = new BreakToken(node, offset);
		let breakHooks = this.hooks.onBreakToken.triggerSync(
			newBreakToken,
			undefined,
			node,
			this
		);
		breakHooks.forEach((newToken) => {
			if (typeof newToken != "undefined") {
				newBreakToken = newToken;
			}
		});

		return newBreakToken;
	}

	shouldBreak(node, limiter) {
		let previousNode = nodeBefore(node, limiter);
		let parentNode = node.parentNode;
		let parentBreakBefore =
			needsBreakBefore(node) &&
			parentNode &&
			!previousNode &&
			needsBreakBefore(parentNode);
		let doubleBreakBefore;

		if (parentBreakBefore) {
			doubleBreakBefore =
				node.dataset.breakBefore === parentNode.dataset.breakBefore;
		}

		return (
			(!doubleBreakBefore && needsBreakBefore(node)) ||
			needsPreviousBreakAfter(node) ||
			needsPageBreak(node, previousNode)
		);
	}

	forceBreak() {
		this.forceRenderBreak = true;
	}

	getStart(source, breakToken) {
		let start;
		let node = breakToken && breakToken.node;

		if (node) {
			start = node;
		} else {
			start = source.firstChild;
		}

		return start;
	}

	append(node, dest, breakToken, shallow = true, rebuild = true) {
		let clone = cloneNode(node, !shallow);
		if (node.parentNode && isElement(node.parentNode)) {
			let parent = findElement(node.parentNode, dest);
			let breakIndex = -1;
			// Rebuild chain
			if (parent) {
				if (
					isText(node) &&
					breakToken &&
					((!Array.isArray(breakToken) &&
						isText(breakToken.node) &&
						breakToken.offset > 0) ||
						(Array.isArray(breakToken) &&
							(breakIndex = breakToken.findIndex(
								(bt) => isText(bt.node) && bt.node === node && bt.offset > 0
							)) !== -1))
				) {
					clone.textContent = clone.textContent.substring(
						breakIndex === -1
							? breakToken.offset
							: breakToken[breakIndex].offset
					);
				}
				if (
					!isText(node) &&
					node.lastElementChild?.classList?.contains(TABLE_BREAK_END_CLASS)
				) {
					clone.innerHTML = "";
				}
				parent.appendChild(clone);
			} else if (rebuild) {
				let fragment = rebuildAncestors(node);
				parent = findElement(node.parentNode, fragment);
				if (!parent) {
					dest.appendChild(clone);
				} else if (
					breakToken &&
					((!Array.isArray(breakToken) &&
						isText(breakToken.node) &&
						breakToken.offset > 0) ||
						(Array.isArray(breakToken) &&
							(breakIndex = breakToken.findIndex(
								(bt) => isText(bt.node) && bt.node === node && bt.offset > 0
							)) !== -1))
				) {
					clone.textContent = clone.textContent.substring(
						breakIndex === -1
							? breakToken.offset
							: breakToken[breakIndex].offset
					);
					parent.appendChild(clone);
				} else {
					parent.appendChild(clone);
				}

				let cloneIdx = clone;
				let destIdx;

				while (
					cloneIdx &&
					cloneIdx.parentNode &&
					cloneIdx.parentNode.nodeType === document.ELEMENT_NODE &&
					!(destIdx = dest.querySelector(
						`[data-ref="${cloneIdx.parentNode.dataset.ref}"]`
					))
				) {
					cloneIdx = cloneIdx.parentNode;
				}

				if (destIdx && cloneIdx) {
					// check table cell that has been duplicated because of the rowSpan > 1
					const tbody =
						destIdx.tagName === "TBODY"
							? destIdx
							: parentOf(destIdx, "TBODY", fragment);
					if (tbody) {
						const bigRowSpans = tbody.querySelectorAll(
							"td[rowspan]:not([rowspan='1'])"
						);
						bigRowSpans.forEach((td) => {
							const foundCell = findElement(td, cloneIdx, true);
							if (foundCell) {
								foundCell.remove(); // remove duplciated cell
							}
						});
					}

					// append found element inside the correct parent
					destIdx.appendChild(cloneIdx);
				} else {
					// append the whole fragment as there isn't any parent in common
					dest.appendChild(fragment);
				}
			} else {
				dest.appendChild(clone);
			}
		} else {
			dest.appendChild(clone);
		}

		if (clone.dataset && clone.dataset.ref) {
			if (!dest.indexOfRefs) {
				dest.indexOfRefs = {};
			}
			dest.indexOfRefs[clone.dataset.ref] = clone;
		}

		let nodeHooks = this.hooks.renderNode.triggerSync(clone, node, this);
		nodeHooks.forEach((newNode) => {
			if (typeof newNode != "undefined") {
				clone = newNode;
			}
		});

		return clone;
	}

	// rebuildTableFromBreakToken(breakTokens, dest) {
	// 	if (!breakTokens || (!Array.isArray(breakTokens) && !breakTokens.node)) {
	// 		return;
	// 	}
	// 	const tokens = Array.isArray(breakTokens) ? breakTokens : [breakTokens];
	// 	tokens.forEach((breakToken) => {
	// 		let node = breakToken.node;
	// 		let td = isElement(node)
	// 			? node.closest("td")
	// 			: node.parentElement?.closest("td");
	// 		if (td) {
	// 			let rendered = findElement(td, dest, true);
	// 			if (!rendered) {
	// 				return;
	// 			}
	// 			// TODO check rowspan
	// 			while ((td = td.nextElementSibling)) {
	// 				if (!dest.querySelector(`[data-ref="${td.dataset.ref}"]`)) {
	// 					this.append(td, dest, null, true);
	// 				}
	// 			}
	// 		}
	// 	});
	// }

	async waitForImages(imgs) {
		let results = Array.from(imgs).map(async (img) => {
			return this.awaitImageLoaded(img);
		});
		await Promise.all(results);
	}

	async awaitImageLoaded(image) {
		return new Promise((resolve) => {
			if (image.complete !== true) {
				image.onload = function () {
					let { width, height } = window.getComputedStyle(image);
					resolve(width, height);
				};
				image.onerror = function (e) {
					let { width, height } = window.getComputedStyle(image);
					resolve(width, height, e);
				};
			} else {
				let { width, height } = window.getComputedStyle(image);
				resolve(width, height);
			}
		});
	}

	avoidBreakInside(node, limiter) {
		let breakNode;

		if (node === limiter) {
			return;
		}

		while (node.parentNode) {
			node = node.parentNode;

			if (node === limiter) {
				break;
			}

			if (window.getComputedStyle(node)["break-inside"] === "avoid") {
				breakNode = node;
				break;
			}
		}
		return breakNode;
	}

	createBreakTokens(overflow, rendered, source) {
		const overflowArray = Array.isArray(overflow) ? overflow : [overflow];
		const breakTokens = overflowArray
			.map((overflow) => {
				let container = overflow.startContainer;
				let offset = overflow.startOffset;
				let node, renderedNode, parent, index, temp;

				if (isElement(container)) {
					temp = child(container, offset);

					if (isElement(temp)) {
						renderedNode = findElement(temp, rendered);

						if (!renderedNode) {
							// Find closest element with data-ref
							let prevNode = prevValidNode(temp);
							if (!isElement(prevNode)) {
								prevNode = prevNode.parentElement;
							}
							renderedNode = findElement(prevNode, rendered);
							// Check if temp is the last rendered node at its level.
							if (!temp.nextSibling) {
								// We need to ensure that the previous sibling of temp is fully rendered.
								const renderedNodeFromSource = findElement(
									renderedNode,
									source
								);
								const walker = document.createTreeWalker(
									renderedNodeFromSource,
									NodeFilter.SHOW_ELEMENT
								);
								const lastChildOfRenderedNodeFromSource = walker.lastChild();
								const lastChildOfRenderedNodeMatchingFromRendered = findElement(
									lastChildOfRenderedNodeFromSource,
									rendered
								);
								// Check if we found that the last child in source
								if (!lastChildOfRenderedNodeMatchingFromRendered) {
									// Pending content to be rendered before virtual break token
									return;
								}
								// Otherwise we will return a break token as per below
							}
							// renderedNode is actually the last unbroken box that does not overflow.
							// Break Token is therefore the next sibling of renderedNode within source node.
							node = findElement(renderedNode, source).nextSibling;
							offset = 0;
						} else {
							node = findElement(renderedNode, source);
							offset = 0;
						}
					} else {
						renderedNode = findElement(container, rendered);

						if (!renderedNode) {
							renderedNode = findElement(prevValidNode(container), rendered);
						}

						parent = findElement(renderedNode, source);
						index = indexOfTextNode(temp, parent);
						// No seperatation for the first textNode of an element
						if (index === 0) {
							node = parent;
							offset = 0;
						} else {
							node = child(parent, index);
							offset = 0;
						}
					}
				} else {
					renderedNode = findElement(container.parentNode, rendered);

					if (!renderedNode) {
						renderedNode = findElement(
							prevValidNode(container.parentNode),
							rendered
						);
					}

					parent = findElement(renderedNode, source);
					index = indexOfTextNode(container, parent);

					if (index === -1) {
						return;
					}

					node = child(parent, index);

					offset += node.textContent.indexOf(container.textContent);
				}

				if (!node) {
					return;
				}

				return new BreakToken(node, offset);
			})
			.filter((token) => !!token);

		return breakTokens.length <= 1 ? breakTokens[0] : breakTokens;
	}

	findBreakToken(
		rendered,
		source,
		bounds = this.bounds,
		prevBreakToken,
		extract = true
	) {
		let overflow = this.findOverflow(
			rendered,
			bounds,
			undefined,
			source,
			prevBreakToken
		);
		let breakTokens, breakLetter;

		let overflowHooks = this.hooks.onOverflow.triggerSync(
			overflow,
			rendered,
			bounds,
			this
		);
		overflowHooks.forEach((newOverflow) => {
			if (typeof newOverflow != "undefined") {
				overflow = newOverflow;
			}
		});

		if (overflow) {
			breakTokens = this.createBreakTokens(overflow, rendered, source); // TODO here
			// breakToken is nullable
			let breakHooks = this.hooks.onBreakToken.triggerSync(
				breakTokens,
				overflow,
				rendered,
				this
			);
			breakHooks.forEach((newToken) => {
				if (typeof newToken != "undefined") {
					breakTokens = newToken;
				}
			});

			// Stop removal if we are in a loop
			if (
				breakTokens &&
				!Array.isArray(breakTokens) &&
				breakTokens.equals(prevBreakToken)
			) {
				return breakTokens;
			}
			const breakLetterArray = [];

			if (
				breakTokens &&
				!Array.isArray(breakTokens) &&
				breakTokens["node"] &&
				breakTokens["offset"] &&
				breakTokens["node"].textContent
			) {
				breakLetter = breakTokens["node"].textContent.charAt(
					breakTokens["offset"]
				);
			} else if (
				breakTokens &&
				Array.isArray(breakTokens) &&
				breakTokens.length > 0
			) {
				breakTokens.forEach((bt) => {
					if (bt["node"] && bt["offset"] && bt["node"].textContent) {
						breakLetterArray.push(bt["node"].textContent.charAt(bt["offset"]));
					}
				});
			} else {
				breakLetter = undefined;
			}

			if (
				breakTokens &&
				((!Array.isArray(breakTokens) && breakTokens.node) ||
					(Array.isArray(breakTokens) && breakTokens.length > 0)) &&
				extract
			) {
				let removed = this.removeOverflow(
					overflow,
					breakLetterArray.length ? breakLetterArray : breakLetter
				);
				this.hooks &&
					this.hooks.afterOverflowRemoved.trigger(removed, rendered, this);
			}
		}
		return breakTokens;
	}

	hasOverflow(element, bounds = this.bounds) {
		element.classList.add(FINDING_OVERFLOW_CLASS); // used to change table cell alignment
		let constrainingElement = element && element.parentNode; // this gets the element, instead of the wrapper for the width workaround
		let { width, height } =
			element.childElementCount > 0
				? {
					width: [...element.children]
						.map((c) => c.offsetWidth)
						.reduce((partialsum, a) => partialsum + a, 0),
					height: [...element.children]
						.map((c) => c.offsetHeight)
						.reduce((partialsum, a) => partialsum + a, 0),
				  }
				: element.getBoundingClientRect();
		let scrollWidth = constrainingElement ? constrainingElement.scrollWidth : 0;
		let scrollHeight = constrainingElement
			? constrainingElement.scrollHeight
			: 0;
		const res =
			Math.max(Math.floor(width), scrollWidth) > Math.round(bounds.width) ||
			Math.max(Math.floor(height), scrollHeight) > Math.round(bounds.height);
		element.classList.remove(FINDING_OVERFLOW_CLASS);
		return res;
	}

	findOverflow(
		rendered,
		bounds = this.bounds,
		gap = this.gap,
		source,
		prevBreakToken = null,
		quitOnFirstFound = false
	) {
		if (!this.hasOverflow(rendered, bounds)) return;

		let start = Math.floor(bounds.left);
		let end = Math.round(bounds.right + gap);
		let vStart = Math.round(bounds.top);
		let vEnd = Math.round(bounds.bottom);
		let range;
		const rangeArray = [];

		let walker = walk(rendered.firstChild, rendered);
		rendered.classList.add(FINDING_OVERFLOW_CLASS); // used to change table cell alignment

		// Find Start
		let next, done, node, offset, skip, breakAvoid, prev, br;
		let skipChildren;
		let insideTableCell;
		let nextCellWithContent;
		while (!done) {
			next = walker.next();
			done = next.done;
			node = next.value;
			skip = false;
			skipChildren = false;
			breakAvoid = false;
			prev = undefined;
			br = undefined;

			if (!node) continue;
			let pos = getBoundingClientRect(node);
			let left = Math.round(pos.left);
			let right = Math.floor(pos.right);
			let top = Math.round(pos.top);
			let bottom = Math.floor(pos.bottom);
			insideTableCell =
				node.tagName === "TD" ? node : parentOf(node, "TD", rendered);

			if (!range && (left >= end || top >= vEnd)) {
				// Check if it is a float
				let isFloat = false;

				// if (
				// 	previousOverflowingNode &&
				// 	!previousOverflowingNode.contains(node) &&
				// 	parentOf(previousOverflowingNode, "TABLE", rendered)
				// ) {
				// 	// set overflowing node to previous overflowing node found if the current node is in a table
				// 	if (isText(previousOverflowingNode)) {
				// 		// do not split from text, get the row
				// 		const parentRow = parentOf(
				// 			previousOverflowingNode,
				// 			"TR",
				// 			rendered
				// 		);
				// 		const previousBreakRow = parentOf(
				// 			prevBreakToken.node,
				// 			"TR",
				// 			rendered
				// 		);

				// 		if (parentRow.dataset.ref !== previousBreakRow?.dataset.ref) {
				// 			if (
				// 				parentRow.dataset.ref !==
				// 				parentOf(node, "TR", rendered)?.dataset.ref
				// 			) {
				// 				node = parentRow;
				// 			} else {
				// 				node = previousOverflowingNode;
				// 			}
				// 		}
				// 	} else {
				// 		node = previousOverflowingNode;
				// 	}
				// }

				// Check if the node is inside a break-inside: avoid table cell
				if (
					insideTableCell &&
					window.getComputedStyle(insideTableCell)["break-inside"] === "avoid"
				) {
					// breaking inside a table cell produces unexpected result, as a workaround, we forcibly avoid break inside in a cell.
					// But we take the whole row, not just the cell that is causing the break.
					prev = insideTableCell.parentElement;
				} else if (isElement(node)) {
					let styles = window.getComputedStyle(node);
					isFloat = styles.getPropertyValue("float") !== "none";
					skip = styles.getPropertyValue("break-inside") === "avoid";
					breakAvoid =
						node.dataset.breakBefore === "avoid" ||
						node.dataset.previousBreakAfter === "avoid";
					prev = breakAvoid && nodeBefore(node, rendered);
					br = node.tagName === "BR" || node.tagName === "WBR";
				}

				let tableRow;
				if (node.nodeName === "TR") {
					tableRow = node;
				} else {
					tableRow = parentOf(node, "TR", rendered);
				}
				if (tableRow) {
					// honor break-inside="avoid" in parent tbody/thead
					let container = tableRow.parentElement;
					if (["TBODY", "THEAD"].includes(container.nodeName)) {
						let styles = window.getComputedStyle(container);
						if (styles.getPropertyValue("break-inside") === "avoid")
							prev = container;
					}
				}

				if (prev) {
					range = document.createRange();
					range.selectNode(prev);
					if (
						insideTableCell &&
						(((nextCellWithContent = this.cellSiblingWithContent(
							prev,
							rendered,
							source
						)) &&
							rangeArray.push(range) &&
							!quitOnFirstFound) ||
							(rangeArray.length > 0 &&
								!quitOnFirstFound &&
								rangeArray.push(range) &&
								false))
					) {
						skipChildren = true;
						range = null;
					} else {
						break;
					}
				}

				if (!br && !isFloat && isElement(node)) {
					range = document.createRange();
					range.selectNode(node);
					if (
						insideTableCell &&
						(((nextCellWithContent = this.cellSiblingWithContent(
							node,
							rendered,
							source
						)) &&
							rangeArray.push(range) &&
							!quitOnFirstFound) ||
							(rangeArray.length > 0 &&
								!quitOnFirstFound &&
								rangeArray.push(range) &&
								false))
					) {
						skipChildren = true;
						range = null;
					} else {
						break;
					}
				}

				if (isText(node) && node.textContent.trim().length) {
					range = document.createRange();
					range.selectNode(node);
					if (
						insideTableCell &&
						(((nextCellWithContent = this.cellSiblingWithContent(
							node,
							rendered,
							source
						)) &&
							rangeArray.push(range) &&
							!quitOnFirstFound) ||
							(rangeArray.length > 0 &&
								!quitOnFirstFound &&
								rangeArray.push(range) &&
								false))
					) {
						skipChildren = true;
						range = null;
					} else {
						break;
					}
				}
			}

			if (
				!skipChildren &&
				!range &&
				isText(node) &&
				node.textContent.trim().length
			) {
				let rects = getClientRects(node);
				let rect;
				left = 0;
				right = 0;
				top = 0;
				bottom = 0;
				for (var i = 0; i != rects.length; i++) {
					rect = rects[i];
					if (rect.width > 0 && (!left || rect.left > left)) {
						left = rect.left;
					}
					if (rect.width > 0 && (!right || rect.right > right)) {
						right = rect.right;
					}
					if (rect.height > 0 && (!top || rect.top > top)) {
						top = rect.top;
					}
					if (rect.height > 0 && (!bottom || rect.bottom > bottom)) {
						bottom = rect.bottom;
					}
				}

				if (left >= end || right >= end || top >= vEnd || bottom >= vEnd) {
					let parentAvoidBreak = breakInsideAvoidParentNode(node.parentNode);

					range = document.createRange();
					if (parentAvoidBreak) {
						if (parentAvoidBreak.tagName === "TD")
							parentAvoidBreak = parentAvoidBreak.parentNode;
						range.selectNode(parentAvoidBreak);
					} else {
						// The text node overflows the current print page so it needs to be split.
						offset = this.textBreak(node, start, end, vStart, vEnd);
						if (offset === 0) {
							// Not even a single character from the text node fits the current print page so the text
							// node needs to be moved to the next print page.
							range.setStartBefore(node);
						} else if (offset) {
							// Only the text before the offset fits the current print page. The rest needs to be moved
							// to the next print page.
							range.setStart(node, offset);
						} else {
							// Undefined offset is unexpected because we know that the text node is not empty (not even
							// blank, because we check node.textContent.trim().length above).
							range = undefined;
						}
					}

					if (
						!parentAvoidBreak &&
						insideTableCell &&
						(((nextCellWithContent = this.cellSiblingWithContent(
							node,
							rendered,
							source
						)) &&
							rangeArray.push(range) &&
							!quitOnFirstFound) ||
							(rangeArray.length > 0 &&
								!quitOnFirstFound &&
								rangeArray.push(range) &&
								false))
					) {
						skipChildren = true;
						range = null;
					} else {
						break;
					}
				}
			}

			const isTableRowWithLongCell =
				node.tagName === "TR"
					? [
						...node.querySelectorAll(
							":scope > td[rowspan]:not([rowspan='1'])"
						),
					  ].some(
						(cell) => Math.round(getBoundingClientRect(cell).bottom) >= vEnd
					  )
					: false;

			// Skip children
			if (
				skip ||
				skipChildren ||
				(right <= end && bottom <= vEnd && !isTableRowWithLongCell)
			) {
				if (!skipChildren) {
					next = nodeAfter(node, rendered);
					if (next) {
						walker = walk(next, rendered);
					}
				} else {
					walker = walk(nextCellWithContent, rendered);
				}
			}
		}

		rendered.classList.remove(FINDING_OVERFLOW_CLASS); // remove process class
		// Find End
		if (rangeArray.length > 0) {
			if (quitOnFirstFound) return rangeArray[0];
			const firstCellBroke =
				rangeArray[0].startContainer.tagName === "TD"
					? rangeArray[0].startContainer
					: parentOf(rangeArray[0].startContainer, "TD", rendered);
			const otherCellsInTable = getAllNextTableCells(firstCellBroke, rendered);
			const breakedRows = [
				...new Set(
					rangeArray.map((range) =>
						range.startContainer.tagName === "TR"
							? range.startContainer
							: parentOf(range.startContainer, "TR", rendered)
					)
				),
			].filter((range) => !!range);
			const prevBreakRows = [
				...new Set(
					(!Array.isArray(prevBreakToken)
						? [prevBreakToken]
						: prevBreakToken
					).map((bt) =>
						!bt?.node || bt.node === "TR"
							? bt.node
							: parentOf(bt.node, "TR", source)
					)
				),
			].filter((node) => !!node);

			// remove cells that are not in line that doesn't have any break
			for (let idx = otherCellsInTable.length - 1; idx > 0; --idx) {
				const cellRow = parentOf(otherCellsInTable[idx], "TR", rendered);
				if (
					cellRow &&
					!breakedRows.includes(cellRow) &&
					!prevBreakRows.some((pbr) => pbr.dataset.ref === cellRow.dataset.ref)
				) {
					otherCellsInTable.splice(idx, 1);
				}
			}

			// add break the other cells that are not detected as overflowing to know that they are already ended
			for (let idx = 0; idx < otherCellsInTable.length; ++idx) {
				const tableCell = otherCellsInTable[idx];
				const col = rangeArray.find(
					(r) =>
						(r.startContainer.tagName === "TD"
							? r.startContainer
							: parentOf(r.startContainer, "TD", rendered)) === tableCell
				);

				if (!col) {
					const node = findElement(tableCell, source);
					let endLimiter;

					if (
						!node.lastChild ||
						node.lastChild.nodeType !== document.ELEMENT_NODE ||
						!node.lastChild.classList.contains(TABLE_BREAK_END_CLASS)
					) {
						endLimiter = document.createElement("span");
						endLimiter.classList.add(TABLE_BREAK_END_CLASS);
						const uuid = UUID();
						endLimiter.setAttribute("data-ref", uuid);
						node.appendChild(endLimiter);
					} else {
						endLimiter = node.lastChild;
					}
					if (!tableCell.lastChild?.classList?.contains(TABLE_BREAK_END_CLASS)) {
						tableCell.appendChild(endLimiter.cloneNode(true));
					}
					// create range at the end of the cell
					range = document.createRange();
					range.selectNode(tableCell.lastChild);
					rangeArray.splice(idx + 1, 0, range);
				}
			}

			rangeArray.forEach((range, index) => {
				const parentCell =
					range.startContainer.tagName === "TD"
						? range.startContainer
						: parentOf(range.startContainer, "TD", rendered);

				if (!parentCell) return;

				// select first child of table if current selection is on an element that is at the beginning of the cell
				if (
					range.startContainer.tagName !== "TD" &&
					range.startOffset === 0 &&
					isFirstChild(range.startContainer, parentCell)
				) {
					range.setStartBefore(parentCell.firstChild);
					parentCell.classList.add(EMPTY_CELL_CLASS);
				}

				range.setEndAfter(parentCell.lastChild);
				if (isLastTableCell(parentCell)) {
					let cellIdx = parentCell;

					while (cellIdx && isLastTableCell(cellIdx)) {
						let parentCellIdx = parentOf(cellIdx, "TD", rendered);
						if (parentCellIdx) {
							range.setEndAfter(parentCellIdx.lastChild);
						}
						cellIdx = parentCellIdx;
					}
				}
			});

			// set selection to the end for the last range
			rangeArray[rangeArray.length - 1].setEndAfter(rendered.lastChild);

			return rangeArray.length === 1 ? rangeArray[0] : rangeArray;
		} else if (range) {
			range.setEndAfter(rendered.lastChild);
			return range;
		}
	}

	cellSiblingWithContent(node, nodeWrapper, treeSource) {
		if (isText(node)) {
			node = node.parentNode;
		}
		const sourceNode = findElement(node, treeSource);
		const nextCellWithContent = nextCellSiblingWithContent(
			sourceNode,
			treeSource
		);
		if (nextCellWithContent) {
			return findElement(nextCellWithContent, nodeWrapper);
		}
		return null;
	}

	findEndToken(rendered, source) {
		if (rendered.childNodes.length === 0) {
			return;
		}

		let lastChild = rendered.lastChild;

		let lastNodeIndex;
		while (lastChild && lastChild.lastChild) {
			if (!validNode(lastChild)) {
				// Only get elements with refs
				lastChild = lastChild.previousSibling;
			} else if (!validNode(lastChild.lastChild)) {
				// Deal with invalid dom items
				lastChild = prevValidNode(lastChild.lastChild);
				break;
			} else {
				lastChild = lastChild.lastChild;
			}
		}

		if (isText(lastChild)) {
			if (lastChild.parentNode.dataset.ref) {
				lastNodeIndex = indexOf(lastChild);
				lastChild = lastChild.parentNode;
			} else {
				lastChild = lastChild.previousSibling;
			}
		}

		let original = findElement(lastChild, source);

		if (lastNodeIndex) {
			original = original.childNodes[lastNodeIndex];
		}

		let after = nodeAfter(original);

		return this.breakAt(after);
	}

	textBreak(node, start, end, vStart, vEnd) {
		let wordwalker = words(node);
		let left = 0;
		let right = 0;
		let top = 0;
		let bottom = 0;
		let word, next, done, pos;
		let offset;
		while (!done) {
			next = wordwalker.next();
			word = next.value;
			done = next.done;

			if (!word) {
				break;
			}

			pos = getBoundingClientRect(word);

			left = Math.floor(pos.left);
			right = Math.floor(pos.right);
			top = Math.floor(pos.top);
			bottom = Math.floor(pos.bottom);

			if (left >= end || top >= vEnd) {
				// The word is completely outside the bounds of the print page. We need to break before it.
				offset = word.startOffset;
				break;
			}

			if (right > end || bottom > vEnd) {
				// The word is partially outside the print page (e.g. a word could be split / hyphenated on two lines of
				// text and only the first part fits into the current print page; or simply because the end of the page
				// truncates vertically the word). We need to see if any of its letters fit into the current print page.
				let letterwalker = letters(word);
				let letter, nextLetter, doneLetter;

				while (!doneLetter) {
					// Note that the letter walker continues to walk beyond the end of the word, until the end of the
					// text node.
					nextLetter = letterwalker.next();
					letter = nextLetter.value;
					doneLetter = nextLetter.done;

					if (!letter) {
						break;
					}

					pos = getBoundingClientRect(letter);
					right = Math.floor(pos.right);
					bottom = Math.floor(pos.bottom);

					// Stop if the letter exceeds the bounds of the print page. We need to break before it.
					if (right > end || bottom > vEnd) {
						offset = letter.startOffset;
						done = true;

						break;
					}
				}
			}
		}

		if (offset > 0 && node.nodeValue.substring(0, offset).trim() === "") {
			// select start of the text with the whitespaces if the offset is at the start of the text
			return 0;
		}
		return offset;
	}

	removeOverflow(overflow, breakLetter) {
		const overflows = Array.isArray(overflow) ? overflow : [overflow];
		let extractedArray = overflows.map((overflow, index) => {
			let { startContainer } = overflow;
			let extracted = overflow.extractContents();

			this.hyphenateAtBreak(
				startContainer,
				Array.isArray(breakLetter) ? breakLetter[index] : breakLetter
			);

			return extracted;
		});
		return extractedArray.length <= 1 ? extractedArray[0] : extractedArray;
	}

	hyphenateAtBreak(startContainer, breakLetter) {
		if (isText(startContainer)) {
			let startText = startContainer.textContent;
			let prevLetter = startText[startText.length - 1];

			// Add a hyphen if previous character is a letter or soft hyphen
			if (
				(breakLetter &&
					/^\w|\u00AD$/.test(prevLetter) &&
					/^\w|\u00AD$/.test(breakLetter)) ||
				(!breakLetter && /^\w|\u00AD$/.test(prevLetter))
			) {
				startContainer.parentNode.classList.add("pagedjs_hyphen");
				startContainer.textContent += this.settings.hyphenGlyph || "\u2011";
			}
		}
	}

	equalTokens(a, b) {
		if (!a || !b) {
			return false;
		}
		if (a["node"] && b["node"] && a["node"] !== b["node"]) {
			return false;
		}
		if (a["offset"] && b["offset"] && a["offset"] !== b["offset"]) {
			return false;
		}
		return true;
	}
}

EventEmitter(Layout.prototype);

export default Layout;
