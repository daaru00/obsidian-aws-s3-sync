import * as os from 'os'
import * as path from 'path'
import { Notice, Plugin } from 'obsidian'
import AwsCredentials, { AwsProfile } from './lib/aws'
import FileManager, { SyncStat, SyncDirection, UPLOAD_SYMBOL, DOWNLOAD_SYMBOL, DELETE_SYMBOL } from './lib/filemanager'
import AwsSyncPluginSettings, { DEFAULT_SETTINGS } from './settings'
import AwsSyncSettingTab from './settings-tab'
import StatusModal from './status-modal'

const PLUGIN_TEXT_PREFIX = 'S3 Bucket: '

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

		await this.loadSettings()
		this.addSettingTab(new AwsSyncSettingTab(this.app, this))

		if (this.settings.enableStatusBar) {
			this.initStatusBar()
		}

		this.setState(PluginState.LOADING)

		this.registerEvent(this.app.vault.on('create', this.onLocalFileChanged.bind(this)))
		this.registerEvent(this.app.vault.on('modify', this.onLocalFileChanged.bind(this)))
		this.registerEvent(this.app.vault.on('delete', this.onLocalFileChanged.bind(this)))
		this.registerEvent(this.app.vault.on('rename', this.onLocalFileChanged.bind(this)))

		await this.initFileManager()

		this.addCommand({
			id: 'aws-s3-check',
			name: 'Check synchronization status',
			callback: async () => {
				await this.runCheck()

				if (this.fileManager && this.fileManager.isInSync()) {
					this.sendNotification('in sync, no changes detected')
					return
				}

				this.openSyncStatusModal()
			}
		})

		this.addCommand({
			id: 'aws-s3-sync',
			name: 'Run synchronization',
			hotkeys: [{
				modifiers: ['Ctrl', 'Shift'],
				key: 's',
			}],
			callback: this.runSync.bind(this)
		})

		this.addCommand({
			id: 'aws-s3-push',
			name: 'Pull from bucket',
			callback: () => {
				return this.runSync(SyncDirection.FROM_REMOTE)
			}
		})

		this.addCommand({
			id: 'aws-s3-pull',
			name: 'Push to bucket',
			callback: () => {
				return this.runSync(SyncDirection.FROM_LOCAL)
			}
		})

		this.setState(PluginState.READY)

		if (this.settings.enableAutoPull) {
			this.initAutoPull()
		}
	}

	openSyncStatusModal(): void {
		if (this.syncStatus && this.fileManager.isInSync() === false) {
			new StatusModal(this).open()
			return
		}
	}

	async initFileManager(): Promise<void> {
		if (!this.areSettingsValid()) {
			return
		}

		this.fileManager = new FileManager(this.app.vault, this.getConfiguredProfile(), {
			bucketName: this.getConfiguredBucketName(),
			pathPrefix: this.getConfiguredBucketPathPrefix(),
			endpoint: this.getConfiguredBucketEndpoint(),
			region: this.settings.region
		}, {
			direction: this.settings.syncDirection,
			localFileProtection: this.settings.localFileProtection
		})

		await this.fileManager.loadLocalFiles()
		await this.fileManager.loadRemoteFiles()
		this.updateStatusBarText()
	}

	initStatusBar(): void {
		this.statusBarItem = this.addStatusBarItem()
		this.statusBarItem.onclick = this.openSyncStatusModal.bind(this)
		this.statusBarItem.addClass('aws-s3-sync-status-bar-item')

		this.setState(PluginState.LOADING)
	}

	setStatusBarText(msg: string): void {
		if (!this.statusBarItem) {
			return
		}
		this.statusBarItem.setText(PLUGIN_TEXT_PREFIX + msg)
	}

	sendNotification(msg: string): void {
		if (!this.settings.enableNotifications) {
			return
		}
		new Notice(PLUGIN_TEXT_PREFIX + msg)
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
			this.setStatusBarText('waiting..')
			return
		}

		if (this.fileManager.isInSync()) {
			this.setStatusBarText('in sync')
		} else {
			const msgs = []
			if (this.syncStatus.filesToUpload.length > 0) {
				msgs.push(UPLOAD_SYMBOL + ' ' + this.syncStatus.filesToUpload.length.toString())
			}
			if (this.syncStatus.filesToDownload.length > 0) {
				msgs.push(DOWNLOAD_SYMBOL + ' ' + this.syncStatus.filesToDownload.length.toString())
			}
			if (this.syncStatus.filesToDelete.length > 0) {
				msgs.push(DELETE_SYMBOL + ' ' + this.syncStatus.filesToDelete.length.toString())
			}
			this.setStatusBarText(msgs.join(' '))
		}
	}

	setState(state: PluginState, msg = ''): void {
		switch (state) {
			case PluginState.LOADING:
				this.setStatusBarText('...')
				break
			case PluginState.READY:
				this.updateStatusBarText()

				switch (this.state) {
					case PluginState.TESTING:
						this.sendNotification('test passed!')
						break
					case PluginState.SYNCHING:
						this.sendNotification('synchronization completed!')
						break
				}
				break
			case PluginState.TESTING:
				this.setStatusBarText('...')
				this.sendNotification('testing..')
				break
			case PluginState.SYNCHING:
				this.setStatusBarText('...')
				this.sendNotification('running..')
				break
			case PluginState.CHECKING:
				this.setStatusBarText('...')
				break
			case PluginState.ERROR:
				this.setStatusBarText('error')
				this.sendNotification('error ' + msg)
				break
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

	getConfiguredBucketEndpoint(): string {
		return this.settings.bucketEndpoint
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings)

		if (!this.settings.enableStatusBar && this.statusBarItem) {
			this.statusBarItem.remove()
			this.statusBarItem = null
		} else if (this.settings.enableStatusBar && !this.statusBarItem) {
			this.initStatusBar()
		}

		await this.initFileManager()

		if (this.settings.enableAutoPull) {
			this.initAutoPull()
		}
	}

	areSettingsValid(): boolean {
		if (typeof this.settings.bucketName !== 'string' || this.settings.bucketName.trim().length === 0) {
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

		if (this.state === PluginState.SYNCHING) {
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
