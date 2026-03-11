import { Plugin } from "obsidian";
import { KanbanView } from "./kanban-view";
import { GanttView } from "./gantt-view";

export default class BaseKanbanPlugin extends Plugin {
	onload() {
		this.registerBasesView("kanban", {
			name: "Kanban",
			icon: "columns-3",
			factory: (controller, containerEl) =>
				new KanbanView(controller, containerEl, this),
			options: (config) => KanbanView.getViewOptions(config),
		});

		this.registerBasesView("gantt", {
			name: "Gantt",
			icon: "gantt-chart",
			factory: (controller, containerEl) =>
				new GanttView(controller, containerEl, this),
			options: (config) => GanttView.getViewOptions(config),
		});
	}
}
