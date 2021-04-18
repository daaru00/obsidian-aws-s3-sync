# Obsidian AWS S3 Sync Plugin

This [Obsidian.md](https://obsidian.md/) plugin allow to evaluate synchronize the vault with a remote AWS S3 Bucket.

## Requirements

- The `~/.aws/credentials` file present in user home and a valid configured profile
- An AWS Account
- An AWS S3 bucket

## Installation

Download zip archive from [GitHub releases page](https://github.com/daaru00/obsidian-aws-s3-sync/releases) and extract it into `<vault>/.obsidian/plugins` directory.

## AWS credentials

This plugin requires a valid AWS profile configured on your local machine, in order to do that follow the [AWS documentation](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-configure.html).

You can configure it manually creating file `~/.aws/credentials` in your user's home adding AWS IAM user credentials:
```
[default]
aws_access_key_id = XXXXXXXXXXXXXXXXXXXX
aws_secret_access_key = XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```
or assuming a IAM Role:
```
[my-company]
aws_access_key_id = XXXXXXXXXXXXXXXXXXXX
aws_secret_access_key = XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

[my-profile]
role_arn = arn:aws:iam::123456789012:role/OrganizationAccountAccessRole
source_profile = my-company
```

Configure the required credentials and bucket section:

![credentials settings](./doc/imgs/credentials-settings.png)

## Usage

This plugin will load a list of remote files from bucket and local files from vault and elaborate sync changes:

![sync changes](./doc/gifs/sync.gif)

Synchronization process can be triggered from command palette:

![commands](./doc/gifs/sync-commands.gif))

When automatic synchronization is enabled every file change (also create and delete) will trigger the synchronization process:

![automatic changes](./doc/gifs/automatic-sync.gif)

## Configurations

Configure the sync behavior, the source (local or remote) will command which file will be create, updated or delete in the source:

![behavior settings](./doc/imgs/behavior-settings.png)

Enable the automatic synchronization to run sync process on vault files changes:

![sync behavior settings](./doc/imgs/behavior-settings.png)

You can also change the notifications behavior, if automatic synchronization is enable maybe you don't need the notice notification:

![notifications settings](./doc/imgs/notifications-settings.png)

## Limitations

### File bigger then 500mb

The synchronization flow use MD5 hash generation in order to be able to identify changed file based on the content. 
File bigger then 500mb will be skipped for performance reasons, so these files will be just uploaded if does not exist remotely or download if not exist locally.

### File bigger then 1GB

File bigger then 1GB cannot be uploaded due a S3 limitation fo basic upload, multipart upload currently is not implemented.
