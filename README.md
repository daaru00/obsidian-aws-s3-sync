# Obsidian AWS S3 Sync Plugin

This [Obsidian.md](https://obsidian.md/) plugin allow to evaluate synchronize the vault with a remote AWS S3 Bucket.

## Features

- Upload changed files to bucket
- Delete trashed files from bucket
- Download new files from bucket
- Automatic synchronization

This plugin will load a list of remote files from bucket and local files from vault and elaborate sync changes:

![bottom status bar](./doc/imgs/status-bar.png)

Notifications will appear when sync process run:

![notifications](./doc/imgs/notifications.png))

## Requirements

- The `.aws/credentials` file present in user home and a valid configured profile.
- An S3 bucket.

## Installation

Download zip archive from [GitHub releases page](https://github.com/daaru00/obsidian-aws-s3-sync/releases) and extract it into `<vault>/.obsidian/plugins` directory.

## Configurations

Configure the required credentials and bucket section (profiles name will be loaded from `~/.aws/credentials` file):

![credentials settings](./doc/imgs/credentials-settings.png)

Configure the sync behavior, the source (local or remote) will command which file will be create, updated or delete in the source:

![behavior settings](./doc/imgs/behavior-settings.png)

Enable the automatic synchronization to run sync process on vault files changes:

![sync behavior settings](./doc/imgs/behavior-settings.png)

You can also change the notifications behavior, if automatic synchronization is enable maybe you don't need the notice notification:

![notifications settings](./doc/imgs/notifications-settings.png)
