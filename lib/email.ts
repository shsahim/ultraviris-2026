import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const region = process.env.AWS_REGION ?? "us-east-1";

const ses = new SESClient({
  region,
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

export interface ContactMessage {
  fromEmail: string;
  message: string;
}

export async function sendContactEmail({
  fromEmail,
  message,
}: ContactMessage): Promise<void> {
  const source = process.env.SES_FROM_EMAIL;
  const destination = process.env.CONTACT_TO_EMAIL ?? "ultraviris@gmail.com";

  if (!source) {
    throw new Error("SES_FROM_EMAIL is not configured");
  }

  const command = new SendEmailCommand({
    Source: source,
    Destination: { ToAddresses: [destination] },
    ReplyToAddresses: [fromEmail],
    Message: {
      Subject: {
        Data: `New contact form message from ${fromEmail}`,
        Charset: "UTF-8",
      },
      Body: {
        Text: {
          Data: `From: ${fromEmail}\n\n${message}`,
          Charset: "UTF-8",
        },
      },
    },
  });

  await ses.send(command);
}

export interface AlertEmail {
  subject: string;
  body: string;
}

/**
 * Sends an operational alert to the ALERT_EMAIL recipient (falls back to
 * CONTACT_TO_EMAIL). Used by the health-check monitor.
 */
export async function sendAlertEmail({ subject, body }: AlertEmail): Promise<void> {
  const source = process.env.SES_FROM_EMAIL;
  const destination =
    process.env.ALERT_EMAIL ?? process.env.CONTACT_TO_EMAIL ?? null;

  if (!source) {
    throw new Error("SES_FROM_EMAIL is not configured");
  }
  if (!destination) {
    throw new Error("ALERT_EMAIL (or CONTACT_TO_EMAIL) is not configured");
  }

  const command = new SendEmailCommand({
    Source: source,
    Destination: { ToAddresses: [destination] },
    Message: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: {
        Text: { Data: body, Charset: "UTF-8" },
      },
    },
  });

  await ses.send(command);
}
