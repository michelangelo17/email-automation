import { Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { SecretReview } from 'cdk-gitify-secrets'

export class SecretReviewStack extends Stack {
  public readonly secretReview: SecretReview

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    this.secretReview = new SecretReview(this, 'SecretReview', {
      preventSelfApproval: false,
      projects: [
        {
          name: 'email-automation',
          environments: ['production'],
        },
      ],
    })
  }
}
