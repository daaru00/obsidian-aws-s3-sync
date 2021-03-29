import { TFile, Vault } from 'obsidian'
import { S3Client, ListObjectsV2Command, _Object, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2CommandOutput } from "@aws-sdk/client-s3"
import { AwsProfile } from './aws'
import * as path from 'path'
import * as crypto from 'crypto'
import { Readable } from 'stream'

export abstract class File {
  fileManager: FileManager;

  path: string;
  extension: string;
  basename: string;
  md5hash: string;
  lastModified: Date

  abstract getContent(): Promise<string>
  abstract delete(): Promise<void>
}

export class LocalFile extends File {
  file: TFile;

  constructor(fileManager: FileManager, file: TFile) {
    super();

    this.fileManager = fileManager
    this.file = file

    this.basename = file.basename
    this.extension = file.extension
    this.path = file.path
    this.lastModified = new Date(file.stat.mtime)
  }

  async calculateMd5() {
    const md5hash = crypto.createHash('md5');
    const content = await this.getContent()
    md5hash.update(Buffer.from(content, 'utf8'));
    this.md5hash = md5hash.digest('hex')
  }

  async getContent(): Promise<string> {
    const content = await this.fileManager.vault.read(this.file)
    return content.toString()
  }

  async upload(): Promise<RemoteFile> {
    const s3 = this.fileManager.getS3Client()

    const uploadPath = path.join(this.fileManager.bucketOpt.pathPrefix, this.path)
    const res = await s3.send(new PutObjectCommand({
      Bucket: this.fileManager.bucketOpt.bucketName,
      Key: uploadPath,
      Body: (await this.getContent()).toString(),
      ContentMD5: Buffer.from(this.md5hash, 'hex').toString('base64')
    }))

    return new RemoteFile(this.fileManager, {
      Key: uploadPath,
      ETag: res.ETag,
      LastModified: this.lastModified
    })
  }

  async delete() {
    console.warn(`WARNING!! deleting local file ${this.path}`)
    await this.fileManager.vault.trash(this.file, true)
  }
}

export class RemoteFile extends File {
  constructor(fileManager: FileManager, obj: _Object) {
    super();

    this.fileManager = fileManager

    this.path = obj.Key.replace(this.fileManager.bucketOpt.pathPrefix, '')
    this.basename = path.basename(this.path)
    this.extension = path.extname(this.path)
    this.md5hash = JSON.parse(obj.ETag)
    this.lastModified = obj.LastModified
  }

  async getContent(): Promise<string> {
    const s3 = this.fileManager.getS3Client()

    const res = await s3.send(new GetObjectCommand({
      Bucket: this.fileManager.bucketOpt.bucketName,
      Key: path.join(this.fileManager.bucketOpt.pathPrefix, this.path),
    }))


    let content = '';
    // @ts-ignore
    const readable = Readable.from(res.Body);
    for await (const chunk of readable) {
      content += chunk;
    }

    return content;
  }

  async download(): Promise<LocalFile> {
    let localFile = this.fileManager.findLocalFile(this.path)
    if (localFile) {
      await this.fileManager.vault.modify(localFile.file, await this.getContent())
    } else {
      const file = await this.fileManager.vault.create(this.path, await this.getContent())
      localFile = new LocalFile(this.fileManager, file)
    }

    return localFile
  }

  async delete() {
    const s3 = this.fileManager.getS3Client()
    await s3.send(new DeleteObjectCommand({
      Bucket: this.fileManager.bucketOpt.bucketName,
      Key: path.join(this.fileManager.bucketOpt.pathPrefix, this.path),
    }))
  }
}

export interface SyncStat {
  filesToUpload: LocalFile[];
	filesToDownload: RemoteFile[];
	filesToDelete: File[];
}

export enum SyncDirection {
	FROM_LOCAL,
	FROM_REMOTE
}

export interface SyncOptions {
	direction: SyncDirection
	localFileProtection: boolean
}

export interface BucketOption {
  bucketName: string
  pathPrefix: string
  region: string
}

export class FileManager {
  vault: Vault;
  profile: AwsProfile;
  bucketOpt: BucketOption;
  syncOpt: SyncOptions;
  localFiles: LocalFile[];
  remoteFiles: RemoteFile[];

  constructor(vault: Vault, profile: AwsProfile, bucketOpt: BucketOption, syncOpt: SyncOptions) {
    this.vault = vault
    this.profile = profile
    this.bucketOpt = bucketOpt
    this.syncOpt = syncOpt
  }

  getS3Client(): S3Client {
    return new S3Client({
      credentials: this.profile.getCredentials(),
      region: this.bucketOpt.region
    })
  }

  async loadLocalFiles(): Promise<LocalFile[]> {
    const files = this.vault.getMarkdownFiles()
    this.localFiles = files.map((file: TFile) => new LocalFile(this, file))

    // Load content for md5 hash elaboration
    await Promise.all(this.localFiles.map(file => file.calculateMd5()))    

    return this.localFiles;
  }

  async loadRemoteFiles(): Promise<RemoteFile[]> {
    const s3 = this.getS3Client()
    let contents: _Object[] = [];

    let continuationToken = undefined
    let maxPages = 10
    do {
      const res: ListObjectsV2CommandOutput = await s3.send(new ListObjectsV2Command({
        Bucket: this.bucketOpt.bucketName,
        Prefix: this.bucketOpt.pathPrefix,
        MaxKeys: 500,
        ContinuationToken: continuationToken
      }))

      maxPages--
  
      if (!res.Contents) {
        break
      }

      contents = contents.concat(res.Contents)
      continuationToken = res.NextContinuationToken
      
    } while (continuationToken != undefined && maxPages > 0)

    this.remoteFiles = contents.map(content => new RemoteFile(this, content))
    return this.remoteFiles
  }

  findRemoteFile(path: string): RemoteFile | undefined {
    return this.remoteFiles.find(file => file.path === path)
  }

  findLocalFile(path: string): LocalFile | undefined {
    return this.localFiles.find(file => file.path === path)
  }

  getSyncStatus(direction?: SyncDirection | undefined): SyncStat | undefined {
    direction = direction !== undefined ? direction : this.syncOpt.direction

    if (!this.remoteFiles || !this.loadLocalFiles) {
      return undefined
    }

    const filesToDelete = []

    console.group('sync status '+direction)

    const filesToDownload = []
    for (const remoteFile of this.remoteFiles) {
      const localFile = this.findLocalFile(remoteFile.path)
      if (!localFile) {
        if (direction === SyncDirection.FROM_LOCAL) {
          console.log('delete remote file', remoteFile.path, 'because does not exist and is from local');
          filesToDelete.push(remoteFile)
        } else {
          console.log('download remote file', remoteFile.path, 'because does not exist and is from remote');
          filesToDownload.push(remoteFile)
        }
      } else if (localFile.md5hash !== remoteFile.md5hash && remoteFile.lastModified > localFile.lastModified) {
        filesToDownload.push(remoteFile)
        console.log('download remote file', remoteFile.path, 'because modified and the remote one is more recent');
      }
    }

    const filesToUpload = []
    for (const localFile of this.localFiles) {
      const remoteFile = this.findRemoteFile(localFile.path)
      if (!remoteFile) {
        if (this.syncOpt.localFileProtection === false && this.syncOpt.direction === SyncDirection.FROM_REMOTE) {
          console.log('delete local file', localFile.path, 'because does not exist and is from remote');
          filesToDelete.push(localFile)
        } else {
          console.log('upload local file', localFile.path, 'because does not exist and is from local');
          filesToUpload.push(localFile)
        }
      } else if (remoteFile.md5hash !== localFile.md5hash && localFile.lastModified > remoteFile.lastModified) {
        filesToUpload.push(localFile)
        console.log('upload local file', remoteFile.path, 'because modified and the local one is more recent');
      }
    }

    console.groupEnd()

    return {
      filesToDownload,
      filesToUpload,
      filesToDelete
    }
  }

  isInSync() {
    const status = this.getSyncStatus()
    return status.filesToDelete.length === 0 && status.filesToUpload.length === 0 && status.filesToDownload.length === 0
  }

  async sync(direction?: SyncDirection | undefined) {
    const stats = this.getSyncStatus(direction)
    const parallel = 10
    
    for (var i = 0; i < stats.filesToDownload.length; i += parallel) {
      const chunk = stats.filesToDownload.slice(i, i + parallel)
      await Promise.all(chunk.map(file => file.download()))
    }

    for (var i = 0; i < stats.filesToUpload.length; i += parallel) {
      const chunk = stats.filesToUpload.slice(i, i + parallel)
      await Promise.all(chunk.map(file => file.upload()))
    }

    for (var i = 0; i < stats.filesToDelete.length; i += parallel) {
      const chunk = stats.filesToDelete.slice(i, i + parallel)
      await Promise.all(chunk.map(file => file.delete()))
    }
  }

}
