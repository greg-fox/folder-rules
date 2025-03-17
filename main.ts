import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { TFile, CachedMetadata, TFolder, SuggestModal } from 'obsidian';

// Remember to rename these classes and interfaces!

interface FolderRule {
	sourceFolder: string;
	destinationFolder: string;
	conditions: {
		field: string;
		operator: 'equals' | 'contains' | 'regex';
		value: string;
	}[];
}

interface FolderRulesSettings {
	rules: FolderRule[];
	enabled: boolean;
	debug: boolean;
}

const DEFAULT_SETTINGS: FolderRulesSettings = {
	rules: [],
	enabled: true,
	debug: false
}

export default class FolderRulesPlugin extends Plugin {
	settings: FolderRulesSettings;
	lastMetadataCache: { [path: string]: any } = {};

	async onload() {
		await this.loadSettings();

		// Add a ribbon icon for toggling the plugin
		const ribbonIconEl = this.addRibbonIcon('folder-plus', 'Folder Rules', (evt: MouseEvent) => {
			// Toggle the plugin
			this.settings.enabled = !this.settings.enabled;
			this.saveSettings();
			new Notice(`Folder Rules ${this.settings.enabled ? 'enabled' : 'disabled'}`);
		});

		// Register for metadata changes instead of file changes
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (this.settings.enabled && file instanceof TFile) {
					this.handleMetadataChange(file);
				}
			})
		);

		// Add settings tab
		this.addSettingTab(new FolderRulesSettingTab(this.app, this));
	}

	async handleMetadataChange(file: TFile) {
		if (!this.settings.enabled) return;

		const filePath = file.path;
		const metadata = this.app.metadataCache.getFileCache(file);
		const oldMetadata = this.lastMetadataCache[filePath];
		
		if (!metadata) return;

		if (this.settings.debug) {
			console.group(`Processing metadata change for: ${filePath}`);
			console.log('Current metadata:', metadata.frontmatter);
			console.log('Previous metadata:', oldMetadata);
		}

		// Store current metadata for future comparison
		this.lastMetadataCache[filePath] = metadata.frontmatter || {};

		// Find matching rules for the file's current folder
		const matchingRules = this.settings.rules.filter(rule => 
			filePath.startsWith(rule.sourceFolder)
		);

		if (this.settings.debug) {
			console.log(`Found ${matchingRules.length} potential rules for source folder`);
			matchingRules.forEach((rule, index) => {
				console.log(`Rule ${index + 1}:`, {
					sourceFolder: rule.sourceFolder,
					destinationFolder: rule.destinationFolder,
					conditions: rule.conditions
				});
			});
		}

		for (const rule of matchingRules) {
			if (this.settings.debug) {
				console.group(`Evaluating rule: ${rule.sourceFolder} → ${rule.destinationFolder}`);
			}

			const matchesNow = await this.checkRuleConditions(rule, metadata);
			const matchedBefore = oldMetadata && await this.checkRuleConditions(rule, { frontmatter: oldMetadata });

			if (this.settings.debug) {
				console.log('Rule evaluation results:', {
					matchesNow,
					matchedBefore,
					willMove: matchesNow && !matchedBefore
				});
				console.groupEnd();
			}

			// Only move if the file newly matches the conditions
			if (matchesNow && !matchedBefore) {
				await this.moveFile(file, rule.destinationFolder);
				break; // Stop after first matching rule
			}
		}

		if (this.settings.debug) {
			console.groupEnd();
		}
	}

	async checkRuleConditions(rule: FolderRule, metadata: CachedMetadata): Promise<boolean> {
		if (!metadata.frontmatter) {
			if (this.settings.debug) {
				console.log('No frontmatter found in metadata');
			}
			return false;
		}

		for (const condition of rule.conditions) {
			const value = this.getMetadataValue(metadata, condition.field);
			
			if (this.settings.debug) {
				console.log(`Checking condition:`, {
					field: condition.field,
					operator: condition.operator,
					expectedValue: condition.value,
					actualValue: value
				});
			}

			if (!value) {
				if (this.settings.debug) {
					console.log(`Field "${condition.field}" not found in metadata`);
				}
				return false;
			}

			let matches = false;
			switch (condition.operator) {
				case 'equals':
					matches = value === condition.value;
					break;
				case 'contains':
					matches = value.includes(condition.value);
					break;
				case 'regex':
					try {
						const regex = new RegExp(condition.value);
						matches = regex.test(value);
					} catch (e) {
						if (this.settings.debug) {
							console.error('Invalid regex:', condition.value, e);
						}
						return false;
					}
					break;
			}

			if (this.settings.debug) {
				console.log(`Condition result: ${matches ? 'matched' : 'did not match'}`);
			}

			if (!matches) return false;
		}
		return true;
	}

	getMetadataValue(metadata: CachedMetadata, field: string): string | undefined {
		if (!metadata.frontmatter) return undefined;
		return metadata.frontmatter[field];
	}

	async moveFile(file: TFile, destinationFolder: string) {
		try {
			const newPath = `${destinationFolder}/${file.name}`;
			if (this.settings.debug) {
				console.log(`Attempting to move file:`, {
					from: file.path,
					to: newPath
				});
			}
			await this.app.fileManager.renameFile(file, newPath);
			if (this.settings.debug) {
				console.log(`Successfully moved ${file.path} to ${newPath}`);
			}
		} catch (e) {
			if (this.settings.debug) {
				console.error(`Failed to move ${file.path}:`, e);
			}
		}
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class FolderSuggestModal extends SuggestModal<TFolder> {
	onSelect: (folder: TFolder) => void;

	constructor(app: App, onSelect: (folder: TFolder) => void) {
		super(app);
		this.onSelect = onSelect;
	}

	getSuggestions(query: string): TFolder[] {
		const folders = this.getAllFolders();
		return folders.filter(folder => 
			folder.path.toLowerCase().includes(query.toLowerCase())
		);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement) {
		el.createEl("div", { text: folder.path });
	}

	onChooseSuggestion(folder: TFolder, evt: MouseEvent | KeyboardEvent) {
		this.onSelect(folder);
	}

	private getAllFolders(): TFolder[] {
		const folders: TFolder[] = [];
		const files = this.app.vault.getAllLoadedFiles();
		
		for (const file of files) {
			if (file instanceof TFolder) {
				folders.push(file);
			}
		}
		
		return folders.sort((a, b) => a.path.localeCompare(b.path));
	}
}

class FolderRulesSettingTab extends PluginSettingTab {
	plugin: FolderRulesPlugin;

	constructor(app: App, plugin: FolderRulesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Enable Folder Rules')
			.setDesc('Toggle automatic note movement based on rules')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enabled)
				.onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Debug Mode')
			.setDesc('Enable detailed logging in the Developer Console (View > Toggle Developer Tools > Console)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debug)
				.onChange(async (value) => {
					this.plugin.settings.debug = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h2', {text: 'Folder Rules'});

		this.plugin.settings.rules.forEach((rule, index) => {
			const ruleContainer = containerEl.createEl('div', {
				cls: 'folder-rule-container'
			});

			const sourceFolderSetting = new Setting(ruleContainer)
				.setName(`Rule ${index + 1}`)
				.setDesc('Source folder')
				.addText(text => {
					text.setPlaceholder('Source folder path')
						.setValue(rule.sourceFolder)
						.onChange(async (value) => {
							rule.sourceFolder = value;
							await this.plugin.saveSettings();
						});
					
					// Add a button to open folder suggestion
					text.inputEl.style.width = "calc(100% - 40px)";
					const browseButton = createEl('button', {
						text: '📁',
						cls: 'folder-browse-button',
						attr: {
							'aria-label': 'Browse folders',
							'style': 'margin-left: 4px;'
						}
					});
					const parent = text.inputEl.parentElement;
					if (parent) {
						parent.appendChild(browseButton);
					}
					
					browseButton.onclick = () => {
						new FolderSuggestModal(this.app, (folder) => {
							text.setValue(folder.path);
							rule.sourceFolder = folder.path;
							this.plugin.saveSettings();
						}).open();
					};
					
					return text;
				});

			const destFolderSetting = new Setting(ruleContainer)
				.setName('Destination')
				.setDesc('Destination folder')
				.addText(text => {
					text.setPlaceholder('Destination folder path')
						.setValue(rule.destinationFolder)
						.onChange(async (value) => {
							rule.destinationFolder = value;
							await this.plugin.saveSettings();
						});
					
					// Add a button to open folder suggestion
					text.inputEl.style.width = "calc(100% - 40px)";
					const browseButton = createEl('button', {
						text: '📁',
						cls: 'folder-browse-button',
						attr: {
							'aria-label': 'Browse folders',
							'style': 'margin-left: 4px;'
						}
					});
					const parent = text.inputEl.parentElement;
					if (parent) {
						parent.appendChild(browseButton);
					}
					
					browseButton.onclick = () => {
						new FolderSuggestModal(this.app, (folder) => {
							text.setValue(folder.path);
							rule.destinationFolder = folder.path;
							this.plugin.saveSettings();
						}).open();
					};
					
					return text;
				})
				.addButton(button => button
					.setButtonText('Delete Rule')
					.onClick(async () => {
						this.plugin.settings.rules.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					}));

			rule.conditions.forEach((condition, condIndex) => {
				const condContainer = ruleContainer.createEl('div', {
					cls: 'condition-container'
				});

				new Setting(condContainer)
					.setName(`Condition ${condIndex + 1}`)
					.addText(text => text
						.setPlaceholder('Metadata field')
						.setValue(condition.field)
						.onChange(async (value) => {
							condition.field = value;
							await this.plugin.saveSettings();
						}))
					.addDropdown(dropdown => dropdown
						.addOption('equals', 'Equals')
						.addOption('contains', 'Contains')
						.addOption('regex', 'Regex')
						.setValue(condition.operator)
						.onChange(async (value: 'equals' | 'contains' | 'regex') => {
							condition.operator = value;
							await this.plugin.saveSettings();
						}))
					.addText(text => text
						.setPlaceholder('Value')
						.setValue(condition.value)
						.onChange(async (value) => {
							condition.value = value;
							await this.plugin.saveSettings();
						}))
					.addButton(button => button
						.setButtonText('Delete')
						.onClick(async () => {
							rule.conditions.splice(condIndex, 1);
							await this.plugin.saveSettings();
							this.display();
						}));
			});

			new Setting(ruleContainer)
				.addButton(button => button
					.setButtonText('Add Condition')
					.onClick(async () => {
						rule.conditions.push({
							field: '',
							operator: 'equals',
							value: ''
						});
						await this.plugin.saveSettings();
						this.display();
					}));
		});

		new Setting(containerEl)
			.addButton(button => button
				.setButtonText('Add Rule')
				.onClick(async () => {
					this.plugin.settings.rules.push({
						sourceFolder: '',
						destinationFolder: '',
						conditions: []
					});
					await this.plugin.saveSettings();
					this.display();
				}));
	}
}
