import { ButtonComponent, Modal } from "obsidian"
import { File } from "./lib/filemanager";
import AwsSyncPlugin from "./main";

export default class StatusModal extends Modal {
  plugin: AwsSyncPlugin

	constructor(plugin: AwsSyncPlugin) {
		super(plugin.app);
    this.plugin = plugin
	}

	onOpen(): void {
		const {contentEl} = this;
    contentEl.addClass('aws-s3-sync-status')

    if (this.plugin.syncStatus.filesToUpload.length > 0) {
      contentEl.createEl('h3', { text: 'Files to upload' })

      for (const fileToUpload of this.plugin.syncStatus.filesToUpload) {
        this.createLink(fileToUpload, '&#8593; ' + fileToUpload.path, [])
      }
    }

    if (this.plugin.syncStatus.filesToDownload.length > 0) {
      contentEl.createEl('h3', { text: 'Files to download' })

      for (const fileToDownload of this.plugin.syncStatus.filesToDownload) {
        this.createLink(fileToDownload, '&#8595; ' + fileToDownload.path, [])
      }
    }

    if (this.plugin.syncStatus.filesToDelete.length > 0) {
      contentEl.createEl('h3', { text: 'Files to delete' })

      for (const fileToDelete of this.plugin.syncStatus.filesToDelete) {
        if (fileToDelete.isLocalFile()) {
          this.createLink(fileToDelete, '&#215; ' + fileToDelete.path, ['aws-s3-sync-action-delete'])
        } else {
          contentEl.createEl('span', { cls: ['aws-s3-sync-action-delete'] }).innerHTML = '&#215; ' + fileToDelete.path
        }
      }
    }

    const buttonContainer = contentEl.createDiv({})
    buttonContainer.addClass('aws-s3-sync-btn-container')

    new ButtonComponent(buttonContainer)
      .setButtonText('Synchronize')
      .setClass('aws-s3-sync-action-sync')
      .onClick(() => {
        this.close()
        this.plugin.runSync()
      })
	}

  createLink(file: File, text: string, cls: string[]): void {
    const {contentEl} = this;

    const span = contentEl.createEl('span', { cls: [...cls, 'aws-s3-sync-action-link'] })
    span.innerHTML = text
    span.onclick = () => this.onPathClick(file.path)
  }

  onPathClick(path: string): void {
    const activeFile = this.app.workspace.getActiveFile()
    if (activeFile && activeFile.path === path) {
      return this.close()
    }
    this.app.workspace.openLinkText(path, "/");
    this.close()
  }

	onClose(): void {
		const {contentEl} = this;
		contentEl.empty();
	}
}
