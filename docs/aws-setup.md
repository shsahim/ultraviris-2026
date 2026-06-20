# AWS setup

`scripts/setup-aws.sh` automates most production AWS resources. A single app
instance is launched with `scripts/launch-ec2.sh`; a load-balanced ASG is
optional (see [Deployment](deployment.md)).

```bash
cp scripts/aws-setup.config.example scripts/aws-setup.config
# Edit: SES_FROM_EMAIL, SSH_KEY_FILE, ENV_SOURCE_FILE (.env.local), optional DOMAIN_NAME

aws configure   # IAM user with permissions listed in scripts/setup-aws.sh header
./scripts/setup-aws.sh
```

## What it creates

| Area | What the script does |
|------|----------------------|
| S3 | Bucket, public-read policy for images, CORS, optional `aws s3 sync` of `public/images/` |
| SES | Starts verification for sender/recipients (you still click email links + request production access) |
| ECR | Repository `ultraviris` |
| GitHub OIDC | IAM role for Actions (ECR push **and** SSM deploy) → outputs `AWS_ROLE_ARN` for repo secret |
| Secrets Manager | `ultraviris/env` and `ultraviris/ssh-key` |
| Health cron | Optional Lambda + EventBridge every 5 min if `HEALTH_CRON_URL` is set |
| TLS | Optional ACM cert + Route 53 validation records if `DOMAIN_NAME` / `HOSTED_ZONE_ID` set |
| EC2 IAM | Instance role + profile (ECR pull, Secrets, S3, SES) **+ `AmazonSSMManagedInstanceCore`** |
| ops | Uploads `scripts/deploy.sh` to `s3://<bucket>/ops/deploy.sh` for instances + pipeline |

Outputs are written to `scripts/aws-setup-outputs.env`.

## Data-fix scripts

Correct `File_Location` extensions in the DB before/at S3 migration:

```bash
npx tsx scripts/fix-file-locations.mts --dry-run
npx tsx scripts/fix-file-locations.mts
```

S3-aware variant:

```bash
npm run fix-file-locations-s3
```
