import * as os from 'os'
import * as path from 'path'
import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian'
import { AwsCredentials, AwsProfile, REGIONS } from './lib/aws'
import { FileManager, SyncStat, SyncDirection } from './lib/filemanager'

const MESSAGE_PREFIX = 'AWS S3: '

enum PluginState {
	LOADING,
	READY,
	TESTING,
	SYNCHING,
	CHECKING,
	ERROR
}

interface AwsSyncPluginSettings {
	profile: string;
	region: string;
	bucketName: string;
	bucketPathPrefix: string;
	localFileProtection: boolean;
	syncDirection: SyncDirection;
	enableStatusBar: boolean;
	enableNotifications: boolean;
	enableAutoSync: boolean;
	autoSyncDebounce: number;
  enableAutoPull: boolean;
  autoPullInterval: number;
}

const DEFAULT_SETTINGS: AwsSyncPluginSettings = {
	profile: 'default',
	region: 'us-east-1',
	bucketName: '',
	bucketPathPrefix: '/%VAULT_NAME%/',
	localFileProtection: true,
	syncDirection: SyncDirection.FROM_LOCAL,
	enableStatusBar: true,
	enableNotifications: true,
	enableAutoSync: false,
	autoSyncDebounce: 2,
  enableAutoPull: false,
  autoPullInterval: 300,
}

export default class AwsSyncPlugin extends Plugin {
	settings: AwsSyncPluginSettings;
	statusBarItem: HTMLElement;
	awsCredentials: AwsCredentials;
	fileManager: FileManager;
  state: PluginState;
	syncStatus: SyncStat;
	autoSyncTimer: any;
  pullInterval: number

	async onload() {
		this.awsCredentials = new AwsCredentials(path.join(os.homedir(), '.aws', 'credentials'))
		await this.awsCredentials.loadProfiles()

		await this.loadSettings();
		this.addSettingTab(new SampleSettingTab(this.app, this));

		this.statusBarItem = this.addStatusBarItem()
		this.setState(PluginState.LOADING)

		this.app.vault.on('create', this.onLocalFileChanged.bind(this))
		this.app.vault.on('modify', this.onLocalFileChanged.bind(this))
		this.app.vault.on('delete', this.onLocalFileChanged.bind(this))
		this.app.vault.on('rename', this.onLocalFileChanged.bind(this))

		await this.initFileManager()
    
		this.addCommand({
			id: 'aws-s3-check',
			name: 'Check synchronization status',
			callback: this.runCheck.bind(this)
		});

		this.addCommand({
			id: 'aws-s3-sync',
			name: 'Run synchronization',
			hotkeys: [{
				modifiers: ["Ctrl", "Shift"],
				key: "s",
			}],
			callback: this.runSync.bind(this)
		});

		this.addCommand({
			id: 'aws-s3-push',
			name: 'Pull from bucket',
			callback: this.runPull.bind(this)
		});

		this.addCommand({
			id: 'aws-s3-pull',
			name: 'Push to bucket',
			callback: this.runPush.bind(this)
		});

		this.setState(PluginState.READY)

    if (this.settings.enableAutoPull) {
      this.initAutoPull()
    }
	}

	async initFileManager() {
		if (!this.areSettingsValid()) {
			return
		}

		this.fileManager = new FileManager(this.app.vault, this.getConfiguredProfile(), {
			bucketName: this.getConfiguredBucketName(), 
			pathPrefix: this.getConfiguredBucketPathPrefix(),
      region: this.settings.region
		}, {
			direction: this.settings.syncDirection,
			localFileProtection: this.settings.localFileProtection  
		})

		await this.fileManager.loadLocalFiles()
		await this.fileManager.loadRemoteFiles()
		this.updateStatusBarText()
	}

	setStatusBarText(msg: string): void {
		if (!this.settings.enableStatusBar) {
			return
		}
		this.statusBarItem.innerHTML = MESSAGE_PREFIX+' '+msg;
	}

	sendNotification(msg: string): void {
		if (!this.settings.enableNotifications) {
			return
		}
		new Notice(MESSAGE_PREFIX+' '+msg)
	}

	async onLocalFileChanged() {
		if (!this.fileManager) {
			return
		}

		if (this.state === PluginState.SYNCHING) {
			return
		}
		
		if (this.settings.enableAutoSync && this.state === PluginState.READY) {
			window.clearTimeout(this.autoSyncTimer)
			this.autoSyncTimer = window.setTimeout(async () => {
				await this.runSync()
				this.updateStatusBarText()
			}, this.settings.autoSyncDebounce * 1000)
		} else {
			await this.fileManager.loadLocalFiles()
			this.updateStatusBarText()
		}
	}

	async onRemoteFileChanged() {
		if (!this.fileManager) {
			return
		}

		if (this.state === PluginState.SYNCHING) {
			return
		}
		
		if (this.settings.enableAutoSync && this.state === PluginState.READY) {
			window.clearTimeout(this.autoSyncTimer)
			this.autoSyncTimer = window.setTimeout(async () => {
				await this.runSync()
				this.updateStatusBarText()
			}, this.settings.autoSyncDebounce * 1000)
		} else {
			await this.fileManager.loadRemoteFiles()
			this.updateStatusBarText()
		}
	}

	updateStatusBarText () {
		if (!this.areSettingsValid()) {
			return
		}

		this.syncStatus = this.fileManager.getSyncStatus()
		if (!this.syncStatus) {
			return
		}

		if (this.settings.enableAutoSync) { 
			this.setStatusBarText('waiting..');
			return
		}

		if (this.fileManager.isInSync()) {
			this.setStatusBarText('in sync');
		} else {
			this.setStatusBarText(
				`&#8593; ${this.syncStatus.filesToUpload.length} `+
				`&#8595; ${this.syncStatus.filesToDownload.length} ` +
				`&#215; ${this.syncStatus.filesToDelete.length} `
			);
		}
	}

	setState(state: PluginState, msg = "") {
		switch (state) {
			case PluginState.LOADING:
				this.setStatusBarText('...');
				break;
			case PluginState.READY:
				this.updateStatusBarText()

				switch (this.state ) {
					case PluginState.TESTING:
						this.sendNotification('test passed!');
						break;
					case PluginState.SYNCHING:
						this.sendNotification('synchronization completed!');
						break;
				}
				break;
			case PluginState.TESTING:
				this.setStatusBarText('testing..');
				this.sendNotification('testing..');
				break;
			case PluginState.SYNCHING:
				this.setStatusBarText('running..');
				this.sendNotification('running..');
				break;
			case PluginState.CHECKING:
				this.setStatusBarText('checking..');
				break;
			case PluginState.ERROR:
				this.setStatusBarText('error');
				this.sendNotification('error ' + msg);
				break;
		}

		this.state = state
	}

	getConfiguredProfile(): AwsProfile | undefined {
		const configuredProfile = this.awsCredentials.getProfileByName(this.settings.profile)
		
		if (!configuredProfile) {
			this.setState(PluginState.ERROR, `profile '${this.settings.profile}' not found`)
			return
		}

		return configuredProfile
	}

	getConfiguredBucketName() {
		return this.settings.bucketName
	}

	getConfiguredBucketPathPrefix() {
		let prefix = this.settings.bucketPathPrefix
		if (prefix.startsWith('/')) {
      prefix = prefix.slice(1)
    }
		if (!prefix.endsWith('/')) {
			prefix += '/'
		}
		prefix = prefix.replace('%VAULT_NAME%', this.app.vault.getName())
		return prefix
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);

		if (!this.settings.enableStatusBar) {
			this.statusBarItem.setText('')
		}

		await this.initFileManager()

    if (this.settings.enableAutoPull) {
      this.initAutoPull()
    }
	}

	areSettingsValid(): boolean {
		if (typeof this.settings.bucketName !== "string" || this.settings.bucketName.trim().length == 0) {
			return false
		}
		
		const configuredProfile = this.getConfiguredProfile()
		if (!configuredProfile) {
			return false
		}

		return true
	}

	async runSync(direction?: SyncDirection): Promise<void> {
		clearTimeout(this.autoSyncTimer)
		
		if (!this.areSettingsValid()) {
			return
		}

		if (this.state == PluginState.SYNCHING) {
			return
		}

		await this.fileManager.loadLocalFiles()
		await this.fileManager.loadRemoteFiles()

		if (this.fileManager.isInSync()) {
			return
		}

		this.setState(PluginState.SYNCHING)

		try {
			await this.fileManager.sync(direction)
		} catch (error) {
			this.setState(PluginState.ERROR, error.message)
			return
		} finally {
			await this.fileManager.loadLocalFiles()
			await this.fileManager.loadRemoteFiles()
			this.updateStatusBarText()
		}

		this.setState(PluginState.READY)
	}

	async runPull() {
		return this.runSync(SyncDirection.FROM_REMOTE)
	}
	
	async runPush() {
		return this.runSync(SyncDirection.FROM_LOCAL)
	}

	async runCheck() {
    if (!this.areSettingsValid()) {
			return
		}

    this.setState(PluginState.CHECKING)
		
    try {
			await this.fileManager.loadLocalFiles()
		  await this.fileManager.loadRemoteFiles()
		  this.updateStatusBarText()
		} catch (error) {
			this.setState(PluginState.ERROR, error.message)
			return
		}

    this.setState(PluginState.READY)
	}

	async runTest() {
		if (!this.areSettingsValid()) {
			return
		}

		this.setState(PluginState.TESTING)

		try {
			await this.fileManager.loadRemoteFiles()
		} catch (error) {
			this.setState(PluginState.ERROR, error.message)
			return
		}

		this.setState(PluginState.READY)
	}

  async runRemotePull() {
    if (!this.areSettingsValid()) {
			return
		}

    this.setState(PluginState.CHECKING)

    try {
			await this.fileManager.loadRemoteFiles()
		} catch (error) {
			this.setState(PluginState.ERROR, error.message)
			return
		}

    // Leave checking status to show some UI stuff
    window.setTimeout(() => {
      this.setState(PluginState.READY)
    }, 1000)
  }

  initAutoPull() {
    window.clearInterval(this.pullInterval)

    this.pullInterval = window.setInterval(this.runRemotePull.bind(this), this.settings.autoPullInterval * 1000)
    this.registerInterval(this.pullInterval)
  }
}

class SampleSettingTab extends PluginSettingTab {
	plugin: AwsSyncPlugin;

	constructor(app: App, plugin: AwsSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	async display(): Promise<void> {
		let {containerEl} = this;

		containerEl.empty();

		const profiles = await this.plugin.awsCredentials.loadProfiles()
		if (profiles.length > 0) {
			new Setting(containerEl)
				.setName('AWS Profile')
				.setDesc('The name AWS profile name configured in credentials file')
				.addDropdown(dropdown => dropdown
					.addOptions(profiles.reduce((acc: any, profile: AwsProfile) => {
						acc[profile.name] = profile.name
						return acc
					}, {}))
					.setValue(this.plugin.settings.profile)
					.onChange(async (value) => {
						this.plugin.settings.profile = value;
						await this.plugin.saveSettings();
					}));
		} else {
			containerEl.createEl('p', {text: 'Cloud not find any AWS profiles!', cls: ['setting-item', 'aws-s3-no-profile']});
		}

    new Setting(containerEl)
      .setName('AWS Region')
      .setDesc('The region where S3 bucket was created')
      .addDropdown(dropdown => dropdown
        .addOptions(REGIONS)
        .setValue(this.plugin.settings.region)
        .onChange(async (value) => {
          this.plugin.settings.region = value;
          await this.plugin.saveSettings();
        }));

		new Setting(containerEl)
			.setName('AWS S3 Bucket Name')
			.setDesc('The name of the AWS S3 bucket')
			.addText(text => text
				.setValue(this.plugin.settings.bucketName)
				.setPlaceholder("REQUIRED")
				.onChange(async (value) => {
					this.plugin.settings.bucketName = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('AWS S3 Objects Path Prefix')
			.setDesc('The prefix of uploaded objects to the AWS S3 bucket')
			.addText(text => text
				.setPlaceholder('use %VAULT_NAME% as placeholder')
				.setValue(this.plugin.settings.bucketPathPrefix)
				.onChange(async (value) => {
					this.plugin.settings.bucketPathPrefix = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Test configurations')
			.setDesc('Will check if credentials are valid and S3 bucket exist')
			.addButton(button => button
				.setButtonText("Test")
				.onClick(async () => {
					await this.plugin.runTest()
				}));

		new Setting(containerEl)
			.setName('Local file protection')
			.setDesc('Protect local files from deletion')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.localFileProtection)
				.onChange(async (value) => {
					this.plugin.settings.localFileProtection = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Synch direction')
			.setDesc('Non existing files in destination will be deleted if not found in source')
			.addDropdown(dropdown => dropdown
        .addOption(SyncDirection.FROM_LOCAL.toString(), "from local to remote")
        .addOption(SyncDirection.FROM_REMOTE.toString(), "from remote to local")
				.setValue(this.plugin.settings.syncDirection.toString())
				.onChange(async (value) => {
          this.plugin.settings.syncDirection = parseInt(value)
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Enable status bar')
			.setDesc('Show the synchronization status application bottom bar')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableStatusBar)
				.onChange(async (value) => {
					this.plugin.settings.enableStatusBar = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Enable notifications')
			.setDesc('Show notifications whe synchronization status change')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableNotifications)
				.onChange(async (value) => {
					this.plugin.settings.enableNotifications = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Enable automatic synchronization')
			.setDesc('Automatically synchronize changes')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableAutoSync)
				.onChange(async (value) => {
					this.plugin.settings.enableAutoSync = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Automatic synchronization debounce')
			.setDesc('Delay the synchronization respect vault changes')
			.addDropdown(dropdown => dropdown
				.addOptions({
					'0': "disabled",
					'2': "2 seconds",
					'5': "5 seconds",
					'10': "10 seconds",
					'30': "30 seconds",
					'60': "1 minute",
					'300': "5 minutes",
				})
				.setValue(this.plugin.settings.autoSyncDebounce.toString())
				.onChange(async (value) => {
					this.plugin.settings.autoSyncDebounce = parseInt(value);
					await this.plugin.saveSettings();
				}));

    new Setting(containerEl)
			.setName('Enable automatic pull')
			.setDesc('Automatically pull changes from S3 bucket')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableAutoPull)
				.onChange(async (value) => {
					this.plugin.settings.enableAutoPull = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Automatic pull interval')
			.setDesc('Interval between S3 bucket changes checks')
			.addDropdown(dropdown => dropdown
				.addOptions({
					'10': "10 seconds",
					'60': "1 minute",
					'300': "5 minutes",
					'600': "10 minutes",
					'1800': "30 minutes",
				})
				.setValue(this.plugin.settings.autoPullInterval.toString())
				.onChange(async (value) => {
					this.plugin.settings.autoPullInterval = parseInt(value);
					await this.plugin.saveSettings();
				}));

	}
}
