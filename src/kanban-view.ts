import {
	BasesView,
	BasesEntry,
	BasesPropertyId,
	BasesViewConfig,
	QueryController,
	TFile,
	Menu,
	setIcon,
} from "obsidian";
import type BaseKanbanPlugin from "./main";

export class KanbanView extends BasesView {
	type = "kanban";

	private boardEl: HTMLElement;
	private plugin: BaseKanbanPlugin;

	// ─── Card drag state ───
	private cardDragState: {
		entry: BasesEntry;
		sourceCard: HTMLElement;
		ghost: HTMLElement;
		indicator: HTMLElement | null;
		offsetX: number;
		offsetY: number;
		rafId: number;
		targetX: number;
		targetY: number;
	} | null = null;

	// ─── Lane drag state ───
	private laneDragState: {
		sourceLane: HTMLElement;
		ghost: HTMLElement;
		indicator: HTMLElement | null;
		offsetX: number;
		offsetY: number;
		rafId: number;
		targetX: number;
		targetY: number;
	} | null = null;

	constructor(
		controller: QueryController,
		containerEl: HTMLElement,
		plugin: BaseKanbanPlugin,
	) {
		super(controller);
		this.plugin = plugin;
		this.boardEl = containerEl.createDiv({ cls: "base-kanban-board" });
	}

	onload(): void {
		this.registerEvent(
			this.app.workspace.on("css-change", () => this.onDataUpdated()),
		);
	}

	onunload(): void {
		this.cleanupCardDrag();
		this.cleanupLaneDrag();
		this.boardEl.empty();
	}

	// ─── Data update ───

	onDataUpdated(): void {
		this.boardEl.empty();

		const statusProp = this.config.getAsPropertyId("statusProperty");
		if (!statusProp) {
			this.renderEmptyState();
			return;
		}

		const sortProp = this.config.getAsPropertyId("sortProperty");
		const lanes = this.buildLanes(statusProp, sortProp);
		this.renderBoard(lanes, statusProp, sortProp);
	}

	private renderEmptyState(): void {
		const emptyEl = this.boardEl.createDiv({ cls: "base-kanban-empty" });
		emptyEl.createEl("p", {
			text: "Select a status property in the view options to create lanes.",
		});
	}

	// ─── Lanes ───

	private buildLanes(
		statusProp: BasesPropertyId,
		sortProp: BasesPropertyId | null,
	): Map<string, BasesEntry[]> {
		const lanes = new Map<string, BasesEntry[]>();

		for (const entry of this.data.data) {
			const val = entry.getValue(statusProp);
			const key = val ? String(val) : "(No value)";
			if (!lanes.has(key)) lanes.set(key, []);
			lanes.get(key)!.push(entry);
		}

		if (sortProp) {
			for (const [, entries] of lanes) {
				entries.sort((a, b) => {
					const aNum = toNum(a.getValue(sortProp));
					const bNum = toNum(b.getValue(sortProp));
					return aNum - bNum;
				});
			}
		}

		return lanes;
	}

	private renderBoard(
		lanes: Map<string, BasesEntry[]>,
		statusProp: BasesPropertyId,
		sortProp: BasesPropertyId | null,
	): void {
		const displayProps = this.config
			.getOrder()
			.filter((p) => p !== statusProp);

		for (const [laneTitle, entries] of lanes) {
			this.renderLane(laneTitle, entries, displayProps, statusProp, sortProp);
		}
	}

	private renderLane(
		title: string,
		entries: BasesEntry[],
		displayProps: BasesPropertyId[],
		statusProp: BasesPropertyId,
		sortProp: BasesPropertyId | null,
	): void {
		const laneEl = this.boardEl.createDiv({ cls: "base-kanban-lane" });
		laneEl.dataset.laneTitle = title;

		// ─ Lane header
		const headerEl = laneEl.createDiv({ cls: "base-kanban-lane-header" });

		const dragHandle = headerEl.createDiv({ cls: "base-kanban-lane-drag-handle" });
		setIcon(dragHandle, "grip-vertical");

		headerEl.createEl("span", {
			cls: "base-kanban-lane-title",
			text: title,
		});
		headerEl.createEl("span", {
			cls: "base-kanban-lane-count",
			text: String(entries.length),
		});

		const addBtn = headerEl.createEl("button", {
			cls: "base-kanban-add-btn clickable-icon",
		});
		setIcon(addBtn, "plus");
		addBtn.addEventListener("click", () => {
			this.createCardInLane(title, statusProp);
		});

		// Lane drag via pointer events on the grip handle
		dragHandle.addEventListener("pointerdown", (e: PointerEvent) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			this.startLaneDrag(e, laneEl, dragHandle);
		});

		// ─ Lane body (card drop zone)
		const bodyEl = laneEl.createDiv({ cls: "base-kanban-lane-body" });
		bodyEl.dataset.lane = title;

		for (const entry of entries) {
			this.renderCard(bodyEl, entry, displayProps, statusProp, sortProp);
		}
	}

	// ─── Lane Pointer Drag ───

	private startLaneDrag(e: PointerEvent, laneEl: HTMLElement, handle: HTMLElement): void {
		handle.setPointerCapture(e.pointerId);

		const rect = laneEl.getBoundingClientRect();
		const ghost = laneEl.cloneNode(true) as HTMLElement;
		ghost.className = "base-kanban-lane base-kanban-drag-ghost base-kanban-lane-ghost";
		document.body.appendChild(ghost);

		const offsetX = e.clientX - rect.left;
		const offsetY = e.clientY - rect.top;

		ghost.style.left = `${e.clientX - offsetX}px`;
		ghost.style.top = `${e.clientY - offsetY}px`;

		laneEl.addClass("base-kanban-lane-dragging");
		this.boardEl.addClass("base-kanban-dragging");

		this.laneDragState = {
			sourceLane: laneEl,
			ghost,
			indicator: null,
			offsetX,
			offsetY,
			rafId: 0,
			targetX: e.clientX,
			targetY: e.clientY,
		};

		const onMove = (ev: PointerEvent) => {
			if (!this.laneDragState) return;
			this.laneDragState.targetX = ev.clientX;
			this.laneDragState.targetY = ev.clientY;
			if (!this.laneDragState.rafId) {
				this.laneDragState.rafId = requestAnimationFrame(() => {
					if (!this.laneDragState) return;
					this.laneDragState.rafId = 0;
					const s = this.laneDragState;
					s.ghost.style.left = `${s.targetX - s.offsetX}px`;
					s.ghost.style.top = `${s.targetY - s.offsetY}px`;
				});
			}
			this.updateLaneDropTarget(ev.clientX);
		};

		const onUp = (_ev: PointerEvent) => {
			handle.removeEventListener("pointermove", onMove);
			handle.removeEventListener("pointerup", onUp);
			handle.removeEventListener("pointercancel", onUp);
			this.finishLaneDrag();
		};

		handle.addEventListener("pointermove", onMove);
		handle.addEventListener("pointerup", onUp);
		handle.addEventListener("pointercancel", onUp);
	}

	private updateLaneDropTarget(clientX: number): void {
		if (!this.laneDragState) return;

		// Remove old indicator
		this.laneDragState.indicator?.remove();
		this.laneDragState.indicator = null;

		const lanes = Array.from(
			this.boardEl.querySelectorAll(".base-kanban-lane:not(.base-kanban-lane-dragging)"),
		) as HTMLElement[];

		let insertBefore: HTMLElement | null = null;
		for (const lane of lanes) {
			const rect = lane.getBoundingClientRect();
			const midX = rect.left + rect.width / 2;
			if (clientX < midX) {
				insertBefore = lane;
				break;
			}
		}

		const indicator = document.createElement("div");
		indicator.className = "base-kanban-lane-drop-indicator";
		this.laneDragState.indicator = indicator;

		if (insertBefore) {
			this.boardEl.insertBefore(indicator, insertBefore);
		} else {
			this.boardEl.appendChild(indicator);
		}
	}

	private finishLaneDrag(): void {
		if (!this.laneDragState) return;
		const state = this.laneDragState;

		// Determine final position from indicator
		const indicator = state.indicator;
		if (indicator) {
			// Insert the source lane where the indicator is
			this.boardEl.insertBefore(state.sourceLane, indicator);
		}

		this.cleanupLaneDrag();
	}

	private cleanupLaneDrag(): void {
		if (!this.laneDragState) return;
		const state = this.laneDragState;

		if (state.rafId) cancelAnimationFrame(state.rafId);
		state.ghost.remove();
		state.indicator?.remove();
		state.sourceLane.removeClass("base-kanban-lane-dragging");
		this.boardEl.removeClass("base-kanban-dragging");
		this.laneDragState = null;
	}

	// ─── Cards ───

	private renderCard(
		parentEl: HTMLElement,
		entry: BasesEntry,
		displayProps: BasesPropertyId[],
		statusProp: BasesPropertyId,
		sortProp: BasesPropertyId | null,
	): void {
		const cardEl = parentEl.createDiv({ cls: "base-kanban-card" });
		cardEl.dataset.filePath = entry.file.path;

		// Context menu
		cardEl.addEventListener("contextmenu", (event) => {
			const menu = new Menu();
			menu.addItem((item) => {
				const i = item.setTitle("Delete note").setIcon("trash");
				if (typeof i.setWarning === "function") i.setWarning(true);
				i.onClick(async () => {
					await this.app.vault.trash(entry.file, true);
				});
			});
			menu.showAtMouseEvent(event);
		});

		// Card drag handle
		const handleEl = cardEl.createDiv({ cls: "base-kanban-card-handle" });
		setIcon(handleEl, "grip-vertical");

		handleEl.addEventListener("pointerdown", (e: PointerEvent) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			this.startCardDrag(e, cardEl, entry, handleEl, statusProp, sortProp);
		});

		// Card content
		const contentEl = cardEl.createDiv({ cls: "base-kanban-card-content" });

		const titleEl = contentEl.createDiv({ cls: "base-kanban-card-title" });
		titleEl.createEl("a", {
			text: entry.file.basename,
			cls: "base-kanban-card-link",
		});
		titleEl.addEventListener("click", () => {
			this.app.workspace.getLeaf(false).openFile(entry.file);
		});

		if (displayProps.length > 0) {
			const propsEl = contentEl.createDiv({ cls: "base-kanban-card-props" });
			for (const prop of displayProps) {
				const val = entry.getValue(prop);
				if (val == null) continue;
				const propEl = propsEl.createDiv({ cls: "base-kanban-card-prop" });
				propEl.createEl("span", {
					cls: "base-kanban-card-prop-label",
					text: this.config.getDisplayName(prop),
				});
				const valueEl = propEl.createEl("span", { cls: "base-kanban-card-prop-value" });
				this.renderPropertyValue(valueEl, String(val), entry);
			}
		}
	}

	// ─── Card Pointer Drag ───

	private startCardDrag(
		e: PointerEvent,
		cardEl: HTMLElement,
		entry: BasesEntry,
		handle: HTMLElement,
		statusProp: BasesPropertyId,
		sortProp: BasesPropertyId | null,
	): void {
		handle.setPointerCapture(e.pointerId);

		const rect = cardEl.getBoundingClientRect();
		const ghost = cardEl.cloneNode(true) as HTMLElement;
		ghost.className = "base-kanban-card base-kanban-drag-ghost base-kanban-card-ghost";
		document.body.appendChild(ghost);

		const offsetX = e.clientX - rect.left;
		const offsetY = e.clientY - rect.top;

		ghost.style.left = `${e.clientX - offsetX}px`;
		ghost.style.top = `${e.clientY - offsetY}px`;

		cardEl.addClass("base-kanban-card-dragging");
		this.boardEl.addClass("base-kanban-dragging");

		this.cardDragState = {
			entry,
			sourceCard: cardEl,
			ghost,
			indicator: null,
			offsetX,
			offsetY,
			rafId: 0,
			targetX: e.clientX,
			targetY: e.clientY,
		};

		const onMove = (ev: PointerEvent) => {
			if (!this.cardDragState) return;
			this.cardDragState.targetX = ev.clientX;
			this.cardDragState.targetY = ev.clientY;
			if (!this.cardDragState.rafId) {
				this.cardDragState.rafId = requestAnimationFrame(() => {
					if (!this.cardDragState) return;
					this.cardDragState.rafId = 0;
					const s = this.cardDragState;
					s.ghost.style.left = `${s.targetX - s.offsetX}px`;
					s.ghost.style.top = `${s.targetY - s.offsetY}px`;
				});
			}
			this.updateCardDropTarget(ev.clientX, ev.clientY);
		};

		const onUp = (_ev: PointerEvent) => {
			handle.removeEventListener("pointermove", onMove);
			handle.removeEventListener("pointerup", onUp);
			handle.removeEventListener("pointercancel", onUp);
			this.finishCardDrag(statusProp, sortProp);
		};

		handle.addEventListener("pointermove", onMove);
		handle.addEventListener("pointerup", onUp);
		handle.addEventListener("pointercancel", onUp);
	}

	private updateCardDropTarget(clientX: number, clientY: number): void {
		if (!this.cardDragState) return;

		// Remove old indicator
		this.cardDragState.indicator?.remove();
		this.cardDragState.indicator = null;

		// Find which lane body the cursor is over
		const laneBodies = Array.from(
			this.boardEl.querySelectorAll(".base-kanban-lane-body"),
		) as HTMLElement[];

		let targetBody: HTMLElement | null = null;
		for (const body of laneBodies) {
			const rect = body.getBoundingClientRect();
			// Use the lane's full horizontal extent (check parent lane element)
			const laneEl = body.parentElement;
			if (!laneEl) continue;
			const laneRect = laneEl.getBoundingClientRect();
			if (
				clientX >= laneRect.left &&
				clientX <= laneRect.right &&
				clientY >= laneRect.top &&
				clientY <= laneRect.bottom
			) {
				targetBody = body;
				break;
			}
		}

		if (!targetBody) return;

		// Find insertion position among cards in this body
		const cards = Array.from(
			targetBody.querySelectorAll(".base-kanban-card:not(.base-kanban-card-dragging)"),
		) as HTMLElement[];

		let insertBefore: HTMLElement | null = null;
		for (const card of cards) {
			const rect = card.getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2) {
				insertBefore = card;
				break;
			}
		}

		const indicator = document.createElement("div");
		indicator.className = "base-kanban-drop-indicator";
		this.cardDragState.indicator = indicator;

		if (insertBefore) {
			targetBody.insertBefore(indicator, insertBefore);
		} else {
			targetBody.appendChild(indicator);
		}
	}

	private finishCardDrag(
		statusProp: BasesPropertyId,
		sortProp: BasesPropertyId | null,
	): void {
		if (!this.cardDragState) return;
		const state = this.cardDragState;

		const indicator = state.indicator;
		if (indicator) {
			const bodyEl = indicator.parentElement;
			if (bodyEl) {
				const laneName = bodyEl.dataset.lane ?? "";
				const insertIndex = this.getDropIndex(bodyEl, indicator);
				this.moveCardToLane(state.entry, laneName, statusProp, sortProp, bodyEl, insertIndex);
			}
		}

		this.cleanupCardDrag();
	}

	private cleanupCardDrag(): void {
		if (!this.cardDragState) return;
		const state = this.cardDragState;

		if (state.rafId) cancelAnimationFrame(state.rafId);
		state.ghost.remove();
		state.indicator?.remove();
		state.sourceCard.removeClass("base-kanban-card-dragging");
		this.boardEl.removeClass("base-kanban-dragging");
		this.cardDragState = null;
	}

	private getDropIndex(bodyEl: HTMLElement, indicator: HTMLElement): number {
		const cards = Array.from(
			bodyEl.querySelectorAll(".base-kanban-card:not(.base-kanban-card-dragging)"),
		);
		for (let i = 0; i < cards.length; i++) {
			// If the indicator comes before this card in DOM, insertion index is i
			if (cards[i].compareDocumentPosition(indicator) & Node.DOCUMENT_POSITION_PRECEDING) {
				// indicator is before cards[i] — not the case, check the other way
			}
			// Simpler: check if indicator is before the card in DOM order
		}
		// More reliable: iterate children and count cards before the indicator
		let idx = 0;
		for (const child of Array.from(bodyEl.children)) {
			if (child === indicator) return idx;
			if (child.classList.contains("base-kanban-card") && !child.classList.contains("base-kanban-card-dragging")) {
				idx++;
			}
		}
		return idx;
	}

	// ─── Link rendering ───

	private renderPropertyValue(
		containerEl: HTMLElement,
		value: string,
		entry: BasesEntry,
	): void {
		const linkPattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|(https?:\/\/[^\s<>\]]+)/g;
		let lastIndex = 0;
		let match: RegExpExecArray | null;

		while ((match = linkPattern.exec(value)) !== null) {
			if (match.index > lastIndex) {
				containerEl.appendText(value.slice(lastIndex, match.index));
			}

			if (match[1] !== undefined) {
				const linkTarget = match[1];
				const displayText = match[2] || match[1];
				const linkEl = containerEl.createEl("a", {
					cls: "internal-link base-kanban-card-internal-link",
					text: displayText,
				});
				linkEl.addEventListener("click", (e) => {
					e.stopPropagation();
					this.app.workspace.openLinkText(linkTarget, entry.file.path);
				});
			} else if (match[3] !== undefined) {
				const url = match[3];
				containerEl.createEl("a", {
					cls: "external-link base-kanban-card-external-link",
					text: url,
					href: url,
					attr: { target: "_blank", rel: "noopener" },
				});
			}

			lastIndex = match.index + match[0].length;
		}

		if (lastIndex < value.length) {
			containerEl.appendText(value.slice(lastIndex));
		}
	}

	// ─── Card move / sort ───

	private async moveCardToLane(
		entry: BasesEntry,
		laneValue: string,
		statusProp: BasesPropertyId,
		sortProp: BasesPropertyId | null,
		bodyEl: HTMLElement,
		insertIndex: number,
	): Promise<void> {
		const propName = statusProp.replace(/^note\./, "");
		const newValue = laneValue === "(No value)" ? null : laneValue;

		await this.app.fileManager.processFrontMatter(entry.file, (fm) => {
			if (newValue === null) delete fm[propName];
			else fm[propName] = newValue;
		});

		if (sortProp) {
			await this.updateSortValues(sortProp, bodyEl, entry, insertIndex);
		}
	}

	private async updateSortValues(
		sortProp: BasesPropertyId,
		bodyEl: HTMLElement,
		movedEntry: BasesEntry,
		insertIndex: number,
	): Promise<void> {
		const sortPropName = sortProp.replace(/^note\./, "");
		const cardEls = Array.from(bodyEl.querySelectorAll(".base-kanban-card")) as HTMLElement[];

		const laneEntries: BasesEntry[] = [];
		for (const cardEl of cardEls) {
			const fp = cardEl.dataset.filePath;
			if (!fp) continue;
			const found = this.data.data.find((e) => e.file.path === fp);
			if (found && found !== movedEntry) laneEntries.push(found);
		}

		laneEntries.splice(insertIndex, 0, movedEntry);

		await Promise.all(
			laneEntries.map((e, i) =>
				this.app.fileManager.processFrontMatter(e.file, (fm) => {
					fm[sortPropName] = (i + 1) * 10;
				}),
			),
		);
	}

	private async createCardInLane(
		laneValue: string,
		statusProp: BasesPropertyId,
	): Promise<void> {
		const propName = statusProp.replace(/^note\./, "");
		const value = laneValue === "(No value)" ? undefined : laneValue;

		await this.createFileForView("", (frontmatter) => {
			if (value !== undefined) frontmatter[propName] = value;
		});
	}

	// ─── View options ───

	static getViewOptions(config: BasesViewConfig): any[] {
		return [
			{
				displayName: "Status property",
				type: "property",
				key: "statusProperty",
				filter: (prop: string) => !prop.startsWith("file."),
				placeholder: "Select a property for lanes",
			},
			{
				displayName: "Sort property",
				type: "property",
				key: "sortProperty",
				filter: (prop: string) => !prop.startsWith("file."),
				placeholder: "Select a number property for ordering",
			},
		];
	}

	public getEphemeralState(): unknown {
		return { scrollLeft: this.boardEl.scrollLeft };
	}

	public setEphemeralState(state: unknown): void {
		if (state && typeof state === "object" && "scrollLeft" in state) {
			this.boardEl.scrollLeft = (state as { scrollLeft: number }).scrollLeft;
		}
	}
}

function toNum(val: unknown): number {
	if (val == null) return Infinity;
	const n = Number(val);
	return isNaN(n) ? Infinity : n;
}
