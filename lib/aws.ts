import * as fs from 'fs'
import * as os from 'os'
import { fromIni }  from "@aws-sdk/credential-provider-ini"
import { Credentials, Provider } from "@aws-sdk/types"

export class AwsProfile {
  name: string

  constructor(name: string) {
    this.name = name
  }

  getCredentials(): Provider<Credentials> {
    return fromIni({ profile: this.name })
  }
}

export class AwsCredentials {
  filePath: string
  profiles: AwsProfile[]
  currentProfile: AwsProfile

  constructor(filePath: string) {
    this.filePath = filePath
  }

  /**
   * Load profiles from credentials file
   */
  async loadProfiles(): Promise<AwsProfile[]> {
    // Check if credentials file exist
    if (fs.existsSync(this.filePath) === false) {
      throw 'Cannot find credentials file'
    }

    // Load credentials file content
    const content = fs.readFileSync(this.filePath).toString('utf8')

    // Split by rows
    const rows = content.split(os.EOL)

    // Loop for each row
    var profiles = []
    let profileIteration = null
    for (const row of rows) {

      // Check if row is an header
      let headerMatch = row.match('^\\[(.*)\\]$')
      if (headerMatch !== null && headerMatch[1]) {

        // Check if profile creation is in progress
        if (profileIteration != null) {

          // Store profile and clean iteration variable
          profiles.push(profileIteration)
          profileIteration = null
        }

        // Create new profile and jump to new row
        profileIteration = new AwsProfile(headerMatch[1].trim())
        continue
      }

      // If row does not match header or value skip
    }

    // Store all founded profiles
    this.profiles = profiles

    // Return only profiles names
    return this.profiles
  }

  /**
   * Get all loaded profiles
   */
  getAllProfiles(): AwsProfile[] {
    return this.profiles
  }

  /**
   * Get project by name
   */
  getProfileByName(name: string): AwsProfile|undefined {
    return this.profiles.find(profile => {
      return profile.name === name
    })
  }
}
