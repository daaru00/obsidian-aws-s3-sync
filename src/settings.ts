import { SyncDirection } from './lib/filemanager'

export default interface AwsSyncPluginSettings {
	profile: string;
	region: string;
	bucketName: string;
	bucketPathPrefix: string;
	bucketEndpoint: string;
	localFileProtection: boolean;
	syncDirection: SyncDirection;
	enableStatusBar: boolean;
	enableNotifications: boolean;
	enableAutoSync: boolean;
	autoSyncDebounce: number;
  enableAutoPull: boolean;
  autoPullInterval: number;
}

export const DEFAULT_SETTINGS: AwsSyncPluginSettings = {
	profile: 'default',
	region: 'us-east-1',
	bucketName: '',
	bucketPathPrefix: '/%VAULT_NAME%/',
	bucketEndpoint: '',
	localFileProtection: true,
	syncDirection: SyncDirection.FROM_LOCAL,
	enableStatusBar: true,
	enableNotifications: true,
	enableAutoSync: false,
	autoSyncDebounce: 2,
  enableAutoPull: false,
  autoPullInterval: 300,
}
