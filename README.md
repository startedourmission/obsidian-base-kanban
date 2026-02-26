# Base Kanban

A Kanban board view for [Obsidian Bases](https://obsidian.md). Organize your notes visually by grouping them into lanes based on a status property.

Requires Obsidian **1.10.0+** (Bases API).

<img width="746" height="525" alt="image" src="https://github.com/user-attachments/assets/a38365e0-d667-4d2c-81df-64c461b643c1" />

## Features

- **Kanban lanes** grouped by any property (e.g. status, priority, category)
- **Drag & drop** cards between lanes to update property values
- **Drag & drop** lanes to reorder columns
- **Sort property** for persistent card ordering within lanes
- **Right-click context menu** to delete notes
- **Link rendering** for `[[wikilinks]]` and URLs in card properties
- **Create cards** directly from lane headers

## Usage

1. Open a `.base` file in Obsidian
2. Click the views dropdown and select **Kanban**
3. In view options, set the **Status property** to group cards into lanes
4. Optionally set a **Sort property** (number type) for persistent card ordering

## Installation

### From Community Plugins

1. Open Obsidian Settings > Community Plugins
2. Search for "Base Kanban"
3. Install and enable

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/startedourmission/obsidian-base-kanban/releases)
2. Create a folder `base-kanban` in your vault's `.obsidian/plugins/` directory
3. Copy the downloaded files into it
4. Enable the plugin in Settings > Community Plugins
