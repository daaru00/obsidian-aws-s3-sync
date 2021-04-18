import { FuzzySuggestModal } from 'obsidian'
import { UPLOAD_SYMBOL, DOWNLOAD_SYMBOL, DELETE_SYMBOL, File } from './lib/filemanager'
import AwsSyncPlugin from './main'

export enum FileChange {
  UPLOAD,
  DOWNLOAD,
  DELETE,
}

export interface ChangedFileItem {
  file: File,
  change: FileChange
}

export default class StatusModal extends FuzzySuggestModal<ChangedFileItem> {
  plugin: AwsSyncPlugin

	constructor(plugin: AwsSyncPlugin) {
		super(plugin.app)
    this.plugin = plugin
	}

  getItems(): ChangedFileItem[] {
    let changedFiles: ChangedFileItem[] = []

    changedFiles = changedFiles.concat(this.plugin.syncStatus.filesToUpload.map(file => ({
      change: FileChange.UPLOAD,
      file,
    })))
    changedFiles = changedFiles.concat(this.plugin.syncStatus.filesToDownload.map(file => ({
      change: FileChange.DOWNLOAD,
      file,
    })))
    changedFiles = changedFiles.concat(this.plugin.syncStatus.filesToDelete.map(file => ({
      change: FileChange.DELETE,
      file,
    })))

    return changedFiles
  }

  getItemText(item: ChangedFileItem): string {
    let itemText = ''

    switch (item.change) {
      case FileChange.UPLOAD:
        itemText += UPLOAD_SYMBOL
        break
      case FileChange.DOWNLOAD:
        itemText += DOWNLOAD_SYMBOL
        break
      case FileChange.DELETE:
        itemText += DELETE_SYMBOL
        break
    }

    return itemText + ' ' + item.file.path
  }

  onChooseItem(item: ChangedFileItem): void {
    const activeFile = this.app.workspace.getActiveFile()
    if (activeFile && activeFile.path === item.file.path) {
      return
    }

    const file = this.app.vault.getAbstractFileByPath(item.file.path)
    if (file === null) {
      this.plugin.sendNotification('cannot open file ' + item.file.path + ', not found in vault')
      return
    }

    this.app.workspace.openLinkText(file.path, '/')
  }
}
