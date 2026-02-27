# Advanced Base

Extra views for [Obsidian Bases](https://obsidian.md) — Kanban board and Gantt chart.

Requires Obsidian **1.10.0+** (Bases API).

<img width="746" height="525" alt="image" src="https://github.com/user-attachments/assets/a38365e0-d667-4d2c-81df-64c461b643c1" />

## Kanban Board

- **Kanban lanes** grouped by any property (e.g. status, priority, category)
- **Drag & drop** cards between lanes to update property values
- **Drag & drop** lanes to reorder columns
- **Sort property** for persistent card ordering within lanes
- **Right-click context menu** to delete notes
- **Link rendering** for `[[wikilinks]]` and URLs in card properties
- **Create cards** directly from lane headers

## Gantt Chart

- **Timeline bars** based on start/end date properties
- **Day / Week / Month** scale toggle
- **Drag bars** to move task dates
- **Resize bar edges** to adjust start or end date
- **Today line** indicator
- **Weekend shading** (day scale)
- Supports `file.ctime`, `file.mtime` and other built-in properties

## Usage

1. Open a `.base` file in Obsidian
2. Click the views dropdown and select **Kanban** or **Gantt**
3. Configure properties in view options

## Installation

### From Community Plugins

1. Open Obsidian Settings > Community Plugins
2. Search for "Advanced Base"
3. Install and enable

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/startedourmission/obsidian-base-kanban/releases)
2. Create a folder `advanced-base` in your vault's `.obsidian/plugins/` directory
3. Copy the downloaded files into it
4. Enable the plugin in Settings > Community Plugins
