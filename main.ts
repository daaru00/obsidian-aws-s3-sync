import * as os from 'os'
import * as path from 'path'
import { Notice, Plugin } from 'obsidian'
import { AwsCredentials, AwsProfile } from './lib/aws'
import { FileManager, SyncStat, SyncDirection } from './lib/filemanager'
import { AwsS3SyncSettingTab, AwsSyncPluginSettings, DEFAULT_SETTINGS } from 'settings'

enum PluginState {
	LOADING,
	READY,
	TESTING,
	SYNCHING,
	CHECKING,
	ERROR
}

export default class AwsSyncPlugin extends Plugin {
	settings: AwsSyncPluginSettings;
	statusBarItem: HTMLElement;
	awsCredentials: AwsCredentials;
	fileManager: FileManager;
	state: PluginState;
	syncStatus: SyncStat;
	autoSyncTimer: number;
	pullInterval: number

	async onload(): Promise<void> {
		this.awsCredentials = new AwsCredentials(path.join(os.homedir(), '.aws', 'credentials'))
		await this.awsCredentials.loadProfiles()

		await this.loadSettings();
		this.addSettingTab(new AwsS3SyncSettingTab(this.app, this));

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
			callback: () => {
				return this.runSync(SyncDirection.FROM_REMOTE)
			}
		});

		this.addCommand({
			id: 'aws-s3-pull',
			name: 'Push to bucket',
			callback: () => {
				return this.runSync(SyncDirection.FROM_LOCAL)
			}
		});

		this.setState(PluginState.READY)

		if (this.settings.enableAutoPull) {
			this.initAutoPull()
		}
	}

	async initFileManager(): Promise<void> {
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
		this.statusBarItem.innerHTML = msg + ' S3 bucket';
	}

	sendNotification(msg: string): void {
		if (!this.settings.enableNotifications) {
			return
		}
		new Notice('S3 bucket sync ' + msg)
	}

	async onLocalFileChanged(): Promise<void> {
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

	async onRemoteFileChanged(): Promise<void> {
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

	updateStatusBarText(): void {
		if (!this.areSettingsValid()) {
			return
		}

		this.syncStatus = this.fileManager.getSyncStatus()
		if (!this.syncStatus) {
			return
		}

		if (this.settings.enableAutoSync) {
			this.setStatusBarText('...');
			return
		}

		if (this.fileManager.isInSync()) {
			this.setStatusBarText('0');
		} else {
			const msgs = []
			if (this.syncStatus.filesToUpload.length > 0) {
				msgs.push(`${this.syncStatus.filesToUpload.length} &#8593;`)
			}
			if (this.syncStatus.filesToDownload.length > 0) {
				msgs.push(`${this.syncStatus.filesToDownload.length} &#8595;`)
			}
			if (this.syncStatus.filesToDelete.length > 0) {
				msgs.push(`${this.syncStatus.filesToDelete.length} &#215;`)
			}
			this.setStatusBarText(msgs.join(' '));
		}
	}

	setState(state: PluginState, msg = ""): void {
		switch (state) {
			case PluginState.LOADING:
				this.setStatusBarText('...');
				break;
			case PluginState.READY:
				this.updateStatusBarText()

				switch (this.state) {
					case PluginState.TESTING:
						this.sendNotification('test passed!');
						break;
					case PluginState.SYNCHING:
						this.sendNotification('synchronization completed!');
						break;
				}
				break;
			case PluginState.TESTING:
				this.setStatusBarText('...');
				this.sendNotification('testing..');
				break;
			case PluginState.SYNCHING:
				this.setStatusBarText('...');
				this.sendNotification('running..');
				break;
			case PluginState.CHECKING:
				this.setStatusBarText('...');
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

	getConfiguredBucketName(): string {
		return this.settings.bucketName
	}

	getConfiguredBucketPathPrefix(): string {
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

		window.setTimeout(() => {
			this.setState(PluginState.READY)
		}, 1000)
	}

	async runCheck(): Promise<void> {
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

		window.setTimeout(() => {
			this.setState(PluginState.READY)
		}, 1000)
	}

	async runTest(): Promise<void> {
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

		window.setTimeout(() => {
			this.setState(PluginState.READY)
		}, 1000)
	}

	async runRemotePull(): Promise<void> {
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

		window.setTimeout(() => {
			this.setState(PluginState.READY)
		}, 1000)
	}

	initAutoPull(): void {
		window.clearInterval(this.pullInterval)

		this.pullInterval = window.setInterval(this.runRemotePull.bind(this), this.settings.autoPullInterval * 1000)
		this.registerInterval(this.pullInterval)
	}
}
