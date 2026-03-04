import {
	BasesView,
	BasesEntry,
	BasesPropertyId,
	BasesViewConfig,
	QueryController,
	Menu,
} from "obsidian";
import type BaseKanbanPlugin from "./main";

interface TaskBar {
	entry: BasesEntry;
	startDate: Date;
	endDate: Date;
	el: HTMLElement;
}

interface SubTask {
	text: string;
	completed: boolean;
	startDate: Date;
	endDate: Date;
}

// ─── Scale config ───

type TimeScale = "day" | "week" | "month";

interface ScaleConfig {
	pxPerDay: number;
	snapDays: number;
}

const SCALES: Record<TimeScale, ScaleConfig> = {
	day: { pxPerDay: 32, snapDays: 1 },
	week: { pxPerDay: 8, snapDays: 7 },
	month: { pxPerDay: 2.5, snapDays: 1 },
};

// ─── Constants ───

const DAY_MS = 86400000;
const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 48;
const LABEL_WIDTH = 160;
const MIN_BAR_PX = 6;

export class GanttView extends BasesView {
	type = "gantt";

	private plugin: BaseKanbanPlugin;
	private rootEl: HTMLElement;
	private tasks: TaskBar[] = [];
	private expandedTasks: Set<string> = new Set();
	private subTaskCache: Map<string, SubTask[]> = new Map();

	// Drag state
	private dragState: {
		task: TaskBar;
		mode: "move" | "resize-start" | "resize-end";
		startX: number;
		origStart: Date;
		origEnd: Date;
		rafId: number;
		targetX: number;
		scale: ScaleConfig;
		rangeStart: Date;
	} | null = null;

	constructor(
		controller: QueryController,
		containerEl: HTMLElement,
		plugin: BaseKanbanPlugin,
	) {
		super(controller);
		this.plugin = plugin;
		this.rootEl = containerEl.createDiv({ cls: "base-gantt-root" });
	}

	onload(): void {
		this.registerEvent(
			this.app.workspace.on("css-change", () => this.onDataUpdated()),
		);
	}

	onunload(): void {
		this.cleanupDrag();
		this.rootEl.empty();
	}

	// ─── Helpers ───

	private getScale(): TimeScale {
		const raw = this.config.get("timeScale");
		if (raw === "week" || raw === "month" || raw === "day") return raw;
		return "day";
	}

	private getScaleConfig(): ScaleConfig {
		return SCALES[this.getScale()];
	}

	private daysToPx(days: number): number {
		return days * this.getScaleConfig().pxPerDay;
	}

	private dateToDayOffset(date: Date, rangeStart: Date): number {
		return (date.getTime() - rangeStart.getTime()) / DAY_MS;
	}

	// ─── Data update ───

	onDataUpdated(): void {
		this.rootEl.empty();
		this.tasks = [];
		this.subTaskCache.clear();

		const startProp = this.config.getAsPropertyId("startDateProperty");
		const endProp = this.config.getAsPropertyId("endDateProperty");

		if (!startProp) {
			this.renderEmptyState();
			return;
		}

		this.buildTasks(startProp, endProp);

		if (this.tasks.length === 0) {
			this.renderEmptyState();
			return;
		}

		this.renderChart(startProp, endProp);
	}

	private renderEmptyState(): void {
		const el = this.rootEl.createDiv({ cls: "base-gantt-empty" });
		el.createEl("p", {
			text: "Select a start date property in the view options to build the timeline.",
		});
	}

	// ─── Build tasks ───

	private buildTasks(
		startProp: BasesPropertyId,
		endProp: BasesPropertyId | null,
	): void {
		for (const entry of this.data.data) {
			const startVal = entry.getValue(startProp);
			let startDate = this.parseDate(startVal);
			if (!startDate) continue;

			let endDate: Date | null = null;
			if (endProp) {
				endDate = this.parseDate(entry.getValue(endProp));
			}
			if (!endDate) {
				endDate = new Date(startDate.getTime() + DAY_MS);
			}

			// Ensure end >= start
			if (endDate.getTime() < startDate.getTime()) {
				const tmp = new Date(endDate);
				endDate = new Date(startDate);
				startDate = tmp;
			}

			this.tasks.push({ entry, startDate, endDate, el: null! });
		}

		this.tasks.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
	}

	private parseDate(val: unknown): Date | null {
		if (val == null) return null;
		// Handle numeric timestamps (e.g. file.ctime, file.mtime)
		// Must be > year 2000 in ms to be a valid timestamp
		const MIN_TIMESTAMP = 946684800000; // 2000-01-01
		if (typeof val === "number") {
			if (val < MIN_TIMESTAMP) return null;
			const d = new Date(val);
			return isNaN(d.getTime()) ? null : d;
		}
		const s = String(val).trim();
		if (s.length === 0) return null;
		// Only parse strings that look like dates (YYYY-MM-DD or ISO format)
		if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
			const d = new Date(s);
			return isNaN(d.getTime()) ? null : d;
		}
		// Try numeric string as timestamp (must be plausible)
		const n = Number(s);
		if (!isNaN(n) && n >= MIN_TIMESTAMP) {
			const d = new Date(n);
			return isNaN(d.getTime()) ? null : d;
		}
		return null;
	}

	private async parseSubTasks(file: import("obsidian").TFile): Promise<SubTask[]> {
		const content = await this.app.vault.read(file);
		const lines = content.split("\n");
		const subTasks: SubTask[] = [];

		for (const line of lines) {
			const taskMatch = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)/);
			if (!taskMatch) continue;

			const completed = taskMatch[1] !== " ";
			const taskText = taskMatch[2];

			// Parse emoji dates
			let startDate: Date | null = null;
			let dueDate: Date | null = null;

			const startMatch = taskText.match(/🛫\s*(\d{4}-\d{2}-\d{2})/u);
			if (startMatch) startDate = new Date(startMatch[1]);

			const dueMatch = taskText.match(/📅\s*(\d{4}-\d{2}-\d{2})/u);
			if (dueMatch) dueDate = new Date(dueMatch[1]);

			const scheduledMatch = taskText.match(/⏳\s*(\d{4}-\d{2}-\d{2})/u);
			if (!startDate && scheduledMatch) startDate = new Date(scheduledMatch[1]);

			// Need at least one date to show on gantt
			if (!startDate && !dueDate) continue;

			// Clean task text (remove emoji dates)
			let cleanText = taskText
				.replace(/(?:🛫|📅|⏳|✅)\s*\d{4}-\d{2}-\d{2}/gu, "")
				.trim();

			const SUB_DAY_MS = 86400000;
			let finalStart: Date;
			let finalEnd: Date;

			if (startDate && dueDate) {
				finalStart = startDate;
				finalEnd = dueDate;
			} else if (dueDate) {
				finalStart = dueDate;
				finalEnd = new Date(dueDate.getTime() + SUB_DAY_MS);
			} else {
				finalStart = startDate!;
				finalEnd = new Date(startDate!.getTime() + SUB_DAY_MS);
			}

			if (finalEnd.getTime() <= finalStart.getTime()) {
				finalEnd = new Date(finalStart.getTime() + SUB_DAY_MS);
			}

			subTasks.push({
				text: cleanText,
				completed,
				startDate: finalStart,
				endDate: finalEnd,
			});
		}

		subTasks.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
		return subTasks;
	}

	// ─── Render chart ───

	private renderScaleToolbar(): void {
		const toolbar = this.rootEl.createDiv({ cls: "base-gantt-scale-toolbar" });
		const current = this.getScale();

		for (const s of ["day", "week", "month"] as TimeScale[]) {
			const btn = toolbar.createEl("button", {
				cls: `base-gantt-scale-btn clickable-icon${s === current ? " is-active" : ""}`,
				text: s === "day" ? "Day" : s === "week" ? "Week" : "Month",
			});
			btn.addEventListener("click", () => {
				this.config.set("timeScale", s);
				this.onDataUpdated();
			});
		}

		// Expand/Collapse all sub-tasks button
		const toggleAllBtn = toolbar.createEl("button", {
			cls: "base-gantt-scale-btn clickable-icon base-gantt-toggle-all-btn",
			text: this.expandedTasks.size > 0 ? "Collapse All" : "Expand All",
		});
		toggleAllBtn.addEventListener("click", async () => {
			if (this.expandedTasks.size > 0) {
				// Collapse all
				this.expandedTasks.clear();
				this.onDataUpdated();
			} else {
				// Expand all
				for (const task of this.tasks) {
					this.expandedTasks.add(task.entry.file.path);
				}
				this.onDataUpdated();
			}
		});
	}

	private renderChart(
		startProp: BasesPropertyId,
		endProp: BasesPropertyId | null,
	): void {
		this.renderScaleToolbar();

		const { rangeStart, totalDays } = this.computeRange();
		const sc = this.getScaleConfig();

		const chartWidth = LABEL_WIDTH + totalDays * sc.pxPerDay;
		const chartHeight = HEADER_HEIGHT + this.tasks.length * ROW_HEIGHT;

		const wrapper = this.rootEl.createDiv({ cls: "base-gantt-wrapper" });
		const chart = wrapper.createDiv({ cls: "base-gantt-chart" });
		chart.style.width = `${chartWidth}px`;
		chart.style.height = `${chartHeight}px`;

		this.renderHeader(chart, rangeStart, totalDays);
		this.renderTodayLine(chart, rangeStart, totalDays);

		const rowsEl = chart.createDiv({ cls: "base-gantt-rows" });
		rowsEl.style.top = `${HEADER_HEIGHT}px`;

		const canDrag = !startProp.startsWith("file.");
		for (let i = 0; i < this.tasks.length; i++) {
			this.renderRow(rowsEl, this.tasks[i], i, rangeStart, totalDays, startProp, endProp, canDrag);
		}

		// Re-expand previously expanded tasks
		if (this.expandedTasks.size > 0) {
			for (const task of this.tasks) {
				const filePath = task.entry.file.path;
				if (!this.expandedTasks.has(filePath)) continue;
				const row = rowsEl.children[Array.from(rowsEl.querySelectorAll(".base-gantt-row")).findIndex(
					(r) => r.querySelector(".base-gantt-task-link")?.textContent === task.entry.file.basename
				)] as HTMLElement;
				if (!row) continue;
				task.el?.addClass("base-gantt-bar-expanded");
				this.parseSubTasks(task.entry.file).then((subTasks) => {
					this.subTaskCache.set(filePath, subTasks);
					this.renderSubRows(row, task, subTasks, rangeStart, totalDays);
					this.recalcChartHeight();
				});
			}
		}

		// Scroll to today
		this.scrollToToday(wrapper, rangeStart, totalDays);
	}

	private computeRange(): { rangeStart: Date; rangeEnd: Date; totalDays: number } {
		let minTime = Infinity;
		let maxTime = -Infinity;

		for (const t of this.tasks) {
			if (t.startDate.getTime() < minTime) minTime = t.startDate.getTime();
			if (t.endDate.getTime() > maxTime) maxTime = t.endDate.getTime();
		}

		const scale = this.getScale();
		const padDays = scale === "month" ? 15 : scale === "week" ? 7 : 3;

		const rangeStart = new Date(minTime - padDays * DAY_MS);
		rangeStart.setHours(0, 0, 0, 0);
		const rangeEnd = new Date(maxTime + padDays * DAY_MS);
		rangeEnd.setHours(0, 0, 0, 0);

		// Cap to prevent DOM explosion
		const MAX_DAYS = 1500;
		const totalDays = Math.min(MAX_DAYS, Math.ceil((rangeEnd.getTime() - rangeStart.getTime()) / DAY_MS));
		return { rangeStart, rangeEnd, totalDays };
	}

	// ─── Header rendering (scale-aware) ───

	private renderHeader(chart: HTMLElement, rangeStart: Date, totalDays: number): void {
		const header = chart.createDiv({ cls: "base-gantt-header" });
		header.style.left = `${LABEL_WIDTH}px`;
		header.style.height = `${HEADER_HEIGHT}px`;

		const scale = this.getScale();
		if (scale === "day") {
			this.renderDayHeader(header, rangeStart, totalDays);
		} else if (scale === "week") {
			this.renderWeekHeader(header, rangeStart, totalDays);
		} else {
			this.renderMonthHeader(header, rangeStart, totalDays);
		}
	}

	private renderDayHeader(header: HTMLElement, rangeStart: Date, totalDays: number): void {
		const sc = this.getScaleConfig();
		const monthRow = header.createDiv({ cls: "base-gantt-month-row" });
		const dayRow = header.createDiv({ cls: "base-gantt-day-row" });

		let currentMonth = -1;
		let monthStartPx = 0;

		for (let i = 0; i < totalDays; i++) {
			const date = new Date(rangeStart.getTime() + i * DAY_MS);
			const month = date.getMonth();
			const isWeekend = date.getDay() === 0 || date.getDay() === 6;

			if (month !== currentMonth) {
				if (currentMonth !== -1) {
					this.addHeaderLabel(monthRow, monthStartPx, i * sc.pxPerDay, this.monthYearStr(date, -1));
				}
				currentMonth = month;
				monthStartPx = i * sc.pxPerDay;
			}

			const cell = dayRow.createDiv({ cls: "base-gantt-day-cell" });
			cell.style.left = `${i * sc.pxPerDay}px`;
			cell.style.width = `${sc.pxPerDay}px`;
			cell.textContent = String(date.getDate());
			if (isWeekend) cell.addClass("base-gantt-weekend");
		}

		if (currentMonth !== -1) {
			const lastDate = new Date(rangeStart.getTime() + (totalDays - 1) * DAY_MS);
			this.addHeaderLabel(monthRow, monthStartPx, totalDays * sc.pxPerDay, this.monthYearStr(lastDate, 0));
		}
	}

	private renderWeekHeader(header: HTMLElement, rangeStart: Date, totalDays: number): void {
		const sc = this.getScaleConfig();
		const monthRow = header.createDiv({ cls: "base-gantt-month-row" });
		const weekRow = header.createDiv({ cls: "base-gantt-day-row" });

		let currentMonth = -1;
		let monthStartPx = 0;

		// Find the first Monday on or after rangeStart
		const firstDay = new Date(rangeStart);
		const dow = firstDay.getDay();
		const offsetToMonday = dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow;
		const firstMonday = new Date(firstDay.getTime() + offsetToMonday * DAY_MS);

		// Render week columns
		for (let d = 0; d < totalDays; d += 7) {
			const weekStart = new Date(rangeStart.getTime() + d * DAY_MS);
			const month = weekStart.getMonth();
			const px = d * sc.pxPerDay;
			const w = Math.min(7, totalDays - d) * sc.pxPerDay;

			if (month !== currentMonth) {
				if (currentMonth !== -1) {
					this.addHeaderLabel(monthRow, monthStartPx, px, this.monthYearStr(weekStart, -1));
				}
				currentMonth = month;
				monthStartPx = px;
			}

			const cell = weekRow.createDiv({ cls: "base-gantt-day-cell" });
			cell.style.left = `${px}px`;
			cell.style.width = `${w}px`;
			cell.textContent = `${weekStart.getMonth() + 1}/${weekStart.getDate()}`;
		}

		if (currentMonth !== -1) {
			const lastDate = new Date(rangeStart.getTime() + (totalDays - 1) * DAY_MS);
			this.addHeaderLabel(monthRow, monthStartPx, totalDays * sc.pxPerDay, this.monthYearStr(lastDate, 0));
		}
	}

	private renderMonthHeader(header: HTMLElement, rangeStart: Date, totalDays: number): void {
		const sc = this.getScaleConfig();
		const yearRow = header.createDiv({ cls: "base-gantt-month-row" });
		const monthRow = header.createDiv({ cls: "base-gantt-day-row" });

		let currentYear = -1;
		let yearStartPx = 0;
		let currentMonth = -1;
		let monthStartDay = 0;

		for (let i = 0; i < totalDays; i++) {
			const date = new Date(rangeStart.getTime() + i * DAY_MS);
			const year = date.getFullYear();
			const month = date.getMonth();
			const monthKey = year * 12 + month;

			if (year !== currentYear) {
				if (currentYear !== -1) {
					this.addHeaderLabel(yearRow, yearStartPx, i * sc.pxPerDay, String(currentYear));
				}
				currentYear = year;
				yearStartPx = i * sc.pxPerDay;
			}

			if (monthKey !== currentMonth) {
				if (currentMonth !== -1) {
					const prevDate = new Date(rangeStart.getTime() + (i - 1) * DAY_MS);
					this.addHeaderLabel(monthRow, monthStartDay * sc.pxPerDay, i * sc.pxPerDay, MONTH_SHORT[prevDate.getMonth()]);
				}
				currentMonth = monthKey;
				monthStartDay = i;
			}
		}

		// Flush last labels
		if (currentYear !== -1) {
			this.addHeaderLabel(yearRow, yearStartPx, totalDays * sc.pxPerDay, String(currentYear));
		}
		if (currentMonth !== -1) {
			const lastDate = new Date(rangeStart.getTime() + (totalDays - 1) * DAY_MS);
			this.addHeaderLabel(monthRow, monthStartDay * sc.pxPerDay, totalDays * sc.pxPerDay, MONTH_SHORT[lastDate.getMonth()]);
		}
	}

	private addHeaderLabel(row: HTMLElement, startPx: number, endPx: number, text: string): void {
		const label = row.createDiv({ cls: "base-gantt-month-label" });
		label.style.left = `${startPx}px`;
		label.style.width = `${endPx - startPx}px`;
		label.textContent = text;
	}

	private monthYearStr(date: Date, offsetMonth: number): string {
		const d = offsetMonth === 0 ? date : new Date(date.getFullYear(), date.getMonth() + offsetMonth, 1);
		return `${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
	}

	// ─── Today line ───

	private renderTodayLine(chart: HTMLElement, rangeStart: Date, totalDays: number): void {
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const dayOffset = this.dateToDayOffset(today, rangeStart);
		if (dayOffset < 0 || dayOffset > totalDays) return;

		const line = chart.createDiv({ cls: "base-gantt-today-line" });
		line.style.left = `${LABEL_WIDTH + this.daysToPx(dayOffset)}px`;
		line.style.top = `${HEADER_HEIGHT}px`;
	}

	private scrollToToday(wrapper: HTMLElement, rangeStart: Date, totalDays: number): void {
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const dayOffset = this.dateToDayOffset(today, rangeStart);
		if (dayOffset < 0 || dayOffset > totalDays) return;

		const todayPx = LABEL_WIDTH + this.daysToPx(dayOffset);
		// Center today in the visible area
		requestAnimationFrame(() => {
			wrapper.scrollLeft = Math.max(0, todayPx - wrapper.clientWidth / 2);
		});
	}

	// ─── Rows ───

	private renderRow(
		rowsEl: HTMLElement,
		task: TaskBar,
		index: number,
		rangeStart: Date,
		totalDays: number,
		startProp: BasesPropertyId,
		endProp: BasesPropertyId | null,
		canDrag: boolean,
	): void {
		const sc = this.getScaleConfig();
		const row = rowsEl.createDiv({ cls: "base-gantt-row" });
		row.style.height = `${ROW_HEIGHT}px`;
		if (index % 2 === 1) row.addClass("base-gantt-row-alt");

		// Label
		const label = row.createDiv({ cls: "base-gantt-row-label" });
		label.style.width = `${LABEL_WIDTH}px`;
		const link = label.createEl("a", {
			text: task.entry.file.basename,
			cls: "base-gantt-task-link",
		});
		link.addEventListener("click", () => {
			this.app.workspace.getLeaf(false).openFile(task.entry.file);
		});

		// Grid background
		const gridEl = row.createDiv({ cls: "base-gantt-row-grid" });
		gridEl.style.left = `${LABEL_WIDTH}px`;
		gridEl.style.width = `${totalDays * sc.pxPerDay}px`;

		this.renderWeekendBg(gridEl, rangeStart, totalDays, sc);

		// Bar
		const startOffset = this.dateToDayOffset(task.startDate, rangeStart);
		const duration = this.dateToDayOffset(task.endDate, rangeStart) - startOffset;
		const barLeft = this.daysToPx(startOffset);
		const barWidth = Math.max(this.daysToPx(duration), MIN_BAR_PX);

		const bar = gridEl.createDiv({ cls: "base-gantt-bar" });
		bar.style.left = `${barLeft}px`;
		bar.style.width = `${barWidth}px`;
		if (!canDrag) bar.style.cursor = "default";
		task.el = bar;

		// Resize handles (only if draggable)
		if (canDrag) {
			bar.createDiv({ cls: "base-gantt-bar-handle base-gantt-bar-handle-start" });
			bar.createDiv({ cls: "base-gantt-bar-handle base-gantt-bar-handle-end" });
		}

		// Bar label
		if (barWidth > 40) {
			bar.createEl("span", {
				cls: "base-gantt-bar-label",
				text: task.entry.file.basename,
			});
		}

		// Context menu
		bar.addEventListener("contextmenu", (e) => {
			const menu = new Menu();
			menu.addItem((item) => {
				const i = item.setTitle("Delete note").setIcon("trash");
				if (typeof i.setWarning === "function") i.setWarning(true);
				i.onClick(async () => {
					await this.app.vault.trash(task.entry.file, true);
				});
			});
			menu.showAtMouseEvent(e);
		});

		// Click to toggle sub-tasks (distinguish from drag)
		let pointerDownPos: { x: number; y: number } | null = null;
		bar.addEventListener("pointerdown", (e: PointerEvent) => {
			pointerDownPos = { x: e.clientX, y: e.clientY };
		});
		bar.addEventListener("click", async (e: MouseEvent) => {
			if (pointerDownPos) {
				const dx = Math.abs(e.clientX - pointerDownPos.x);
				const dy = Math.abs(e.clientY - pointerDownPos.y);
				if (dx > 3 || dy > 3) return; // Was a drag, not a click
			}

			const filePath = task.entry.file.path;
			const isExpanded = this.expandedTasks.has(filePath);

			if (isExpanded) {
				this.expandedTasks.delete(filePath);
				// Remove sub-rows
				const subRows = row.parentElement?.querySelectorAll(
					`.base-gantt-sub-row[data-parent="${CSS.escape(filePath)}"]`
				);
				subRows?.forEach((el) => el.remove());
				bar.removeClass("base-gantt-bar-expanded");
				this.recalcChartHeight();
			} else {
				this.expandedTasks.add(filePath);
				bar.addClass("base-gantt-bar-expanded");
				const subTasks = await this.parseSubTasks(task.entry.file);
				this.subTaskCache.set(filePath, subTasks);
				this.renderSubRows(row, task, subTasks, rangeStart, totalDays);
				this.recalcChartHeight();
			}
		});

		if (!canDrag) return;

		// Drag: move
		bar.addEventListener("pointerdown", (e: PointerEvent) => {
			if (e.button !== 0) return;
			const target = e.target as HTMLElement;
			if (target.classList.contains("base-gantt-bar-handle")) return;
			e.preventDefault();
			e.stopPropagation();
			this.startDrag(e, task, "move", bar, rangeStart, startProp, endProp);
		});

		// Drag: resize handles
		const handles = bar.querySelectorAll(".base-gantt-bar-handle");
		handles[0]?.addEventListener("pointerdown", (e: PointerEvent) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			this.startDrag(e, task, "resize-start", bar, rangeStart, startProp, endProp);
		});
		handles[1]?.addEventListener("pointerdown", (e: PointerEvent) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			this.startDrag(e, task, "resize-end", bar, rangeStart, startProp, endProp);
		});
	}

	private renderSubRows(
		parentRow: HTMLElement,
		parentTask: TaskBar,
		subTasks: SubTask[],
		rangeStart: Date,
		totalDays: number,
	): void {
		const sc = this.getScaleConfig();
		const filePath = parentTask.entry.file.path;
		let insertAfter: HTMLElement = parentRow;

		for (let i = 0; i < subTasks.length; i++) {
			const sub = subTasks[i];
			const subRow = createDiv({ cls: "base-gantt-sub-row" });
			subRow.dataset.parent = filePath;
			subRow.style.height = `${ROW_HEIGHT}px`;

			// Sub-task label (indented)
			const label = subRow.createDiv({ cls: "base-gantt-sub-row-label" });
			label.style.width = `${LABEL_WIDTH}px`;

			label.createEl("span", {
				cls: `base-gantt-sub-checkbox ${sub.completed ? "is-checked" : ""}`,
				text: sub.completed ? "\u2713" : "",
			});
			label.createEl("span", {
				cls: "base-gantt-sub-task-text",
				text: sub.text,
			});

			// Grid
			const gridEl = subRow.createDiv({ cls: "base-gantt-row-grid" });
			gridEl.style.left = `${LABEL_WIDTH}px`;
			gridEl.style.width = `${totalDays * sc.pxPerDay}px`;

			// Sub bar
			const startOffset = this.dateToDayOffset(sub.startDate, rangeStart);
			const duration = this.dateToDayOffset(sub.endDate, rangeStart) - startOffset;
			const barLeft = this.daysToPx(startOffset);
			const barWidth = Math.max(this.daysToPx(duration), MIN_BAR_PX);

			const subBar = gridEl.createDiv({
				cls: `base-gantt-sub-bar ${sub.completed ? "is-completed" : ""}`,
			});
			subBar.style.left = `${barLeft}px`;
			subBar.style.width = `${barWidth}px`;

			if (barWidth > 40) {
				subBar.createEl("span", {
					cls: "base-gantt-bar-label",
					text: sub.text,
				});
			}

			// Insert after parent row (or after last sub-row)
			insertAfter.insertAdjacentElement("afterend", subRow);
			insertAfter = subRow;
		}
	}

	private recalcChartHeight(): void {
		const rows = this.rootEl.querySelector(".base-gantt-rows");
		if (!rows) return;
		const totalRows = rows.childElementCount;
		const chart = this.rootEl.querySelector(".base-gantt-chart") as HTMLElement;
		if (chart) {
			chart.style.height = `${HEADER_HEIGHT + totalRows * ROW_HEIGHT}px`;
		}
	}

	private renderWeekendBg(gridEl: HTMLElement, rangeStart: Date, totalDays: number, sc: ScaleConfig): void {
		const scale = this.getScale();
		// Only render weekend shading for day scale (too dense otherwise)
		if (scale !== "day") return;

		for (let i = 0; i < totalDays; i++) {
			const date = new Date(rangeStart.getTime() + i * DAY_MS);
			if (date.getDay() === 0 || date.getDay() === 6) {
				const wknd = gridEl.createDiv({ cls: "base-gantt-weekend-bg" });
				wknd.style.left = `${i * sc.pxPerDay}px`;
				wknd.style.width = `${sc.pxPerDay}px`;
			}
		}
	}

	// ─── Drag ───

	private startDrag(
		e: PointerEvent,
		task: TaskBar,
		mode: "move" | "resize-start" | "resize-end",
		barEl: HTMLElement,
		rangeStart: Date,
		startProp: BasesPropertyId,
		endProp: BasesPropertyId | null,
	): void {
		barEl.setPointerCapture(e.pointerId);

		this.dragState = {
			task,
			mode,
			startX: e.clientX,
			origStart: new Date(task.startDate),
			origEnd: new Date(task.endDate),
			rafId: 0,
			targetX: e.clientX,
			scale: this.getScaleConfig(),
			rangeStart,
		};

		barEl.addClass("base-gantt-bar-dragging");
		this.rootEl.addClass("base-gantt-dragging");

		const onMove = (ev: PointerEvent) => {
			if (!this.dragState) return;
			this.dragState.targetX = ev.clientX;
			if (!this.dragState.rafId) {
				this.dragState.rafId = requestAnimationFrame(() => {
					if (!this.dragState) return;
					this.dragState.rafId = 0;
					this.updateDrag(barEl);
				});
			}
		};

		const onUp = () => {
			barEl.removeEventListener("pointermove", onMove);
			barEl.removeEventListener("pointerup", onUp);
			barEl.removeEventListener("pointercancel", onUp);
			this.finishDrag(barEl, startProp, endProp);
		};

		barEl.addEventListener("pointermove", onMove);
		barEl.addEventListener("pointerup", onUp);
		barEl.addEventListener("pointercancel", onUp);
	}

	private updateDrag(barEl: HTMLElement): void {
		if (!this.dragState) return;
		const s = this.dragState;
		const deltaX = s.targetX - s.startX;
		const deltaDays = Math.round(deltaX / s.scale.pxPerDay / s.scale.snapDays) * s.scale.snapDays;

		if (s.mode === "move") {
			s.task.startDate = new Date(s.origStart.getTime() + deltaDays * DAY_MS);
			s.task.endDate = new Date(s.origEnd.getTime() + deltaDays * DAY_MS);
		} else if (s.mode === "resize-start") {
			const newStart = new Date(s.origStart.getTime() + deltaDays * DAY_MS);
			if (newStart.getTime() < s.task.endDate.getTime()) {
				s.task.startDate = newStart;
			}
		} else if (s.mode === "resize-end") {
			const newEnd = new Date(s.origEnd.getTime() + deltaDays * DAY_MS);
			if (newEnd.getTime() > s.task.startDate.getTime()) {
				s.task.endDate = newEnd;
			}
		}

		const startOff = this.dateToDayOffset(s.task.startDate, s.rangeStart);
		const dur = this.dateToDayOffset(s.task.endDate, s.rangeStart) - startOff;
		barEl.style.left = `${startOff * s.scale.pxPerDay}px`;
		barEl.style.width = `${Math.max(dur * s.scale.pxPerDay, MIN_BAR_PX)}px`;
	}

	private async finishDrag(
		barEl: HTMLElement,
		startProp: BasesPropertyId,
		endProp: BasesPropertyId | null,
	): Promise<void> {
		if (!this.dragState) return;
		const s = this.dragState;

		barEl.removeClass("base-gantt-bar-dragging");
		this.rootEl.removeClass("base-gantt-dragging");
		if (s.rafId) cancelAnimationFrame(s.rafId);

		const startPropName = startProp.replace(/^note\./, "");
		await this.app.fileManager.processFrontMatter(s.task.entry.file, (fm) => {
			fm[startPropName] = this.formatDate(s.task.startDate);
		});

		if (endProp) {
			const endPropName = endProp.replace(/^note\./, "");
			await this.app.fileManager.processFrontMatter(s.task.entry.file, (fm) => {
				fm[endPropName] = this.formatDate(s.task.endDate);
			});
		}

		this.dragState = null;
	}

	private cleanupDrag(): void {
		if (!this.dragState) return;
		if (this.dragState.rafId) cancelAnimationFrame(this.dragState.rafId);
		this.dragState = null;
	}

	private formatDate(d: Date): string {
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, "0");
		const day = String(d.getDate()).padStart(2, "0");
		return `${y}-${m}-${day}`;
	}

	// ─── View options ───

	static getViewOptions(config: BasesViewConfig): any[] {
		return [
			{
				displayName: "Start date property",
				type: "property",
				key: "startDateProperty",
				placeholder: "Select a date property for task start",
			},
			{
				displayName: "End date property",
				type: "property",
				key: "endDateProperty",
				placeholder: "Select a date property for task end (optional)",
			},
		];
	}

	public getEphemeralState(): unknown {
		const wrapper = this.rootEl.querySelector(".base-gantt-wrapper");
		return {
			scrollLeft: (wrapper as HTMLElement)?.scrollLeft ?? 0,
			scrollTop: (wrapper as HTMLElement)?.scrollTop ?? 0,
		};
	}

	public setEphemeralState(state: unknown): void {
		if (state && typeof state === "object") {
			const s = state as { scrollLeft?: number; scrollTop?: number };
			const wrapper = this.rootEl.querySelector(".base-gantt-wrapper") as HTMLElement;
			if (wrapper) {
				if (s.scrollLeft != null) wrapper.scrollLeft = s.scrollLeft;
				if (s.scrollTop != null) wrapper.scrollTop = s.scrollTop;
			}
		}
	}
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
