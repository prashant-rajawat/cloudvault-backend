import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config({ override: true });

export interface SendShareEmailOptions {
  recipientEmail?: string;
  to?: string;
  senderName: string;
  senderEmail?: string;
  fileName: string;
  fileSize: number | null;
  permission: string;
  expiresAt: string | null;
  shareUrl: string;
  passwordProtected?: boolean;
  passwordRequired?: boolean;
}

export interface SendShareEmailResult {
  success: boolean;
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
  response?: string;
  error?: string;
  errorCode?: string;
  sender?: string;
  recipient?: string;
  authSuccess?: boolean;
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Creates and initializes a nodemailer transporter using the platform-configured SMTP credentials
 */
function createPlatformTransporter() {
  const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
  const smtpPort = parseInt(process.env.SMTP_PORT || "587", 10);
  const smtpUser = (process.env.SMTP_USER || "").trim();
  const rawPass = process.env.SMTP_PASS || "";
  // Google App Passwords and standard SMTP passwords: strip formatting spaces
  const smtpPass = rawPass.replace(/[\s\u00A0]+/g, "");

  if (smtpHost.includes("gmail.com")) {
    return {
      transporter: nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      }),
      host: "smtp.gmail.com",
      port: 587,
      user: smtpUser,
      passConfigured: Boolean(smtpPass),
    };
  }

  return {
    transporter: nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    }),
    host: smtpHost,
    port: smtpPort,
    user: smtpUser,
    passConfigured: Boolean(smtpPass),
  };
}

/**
 * Sends a file/folder share notification email to the explicit recipient email.
 * Uses the platform-owned server-side SMTP configuration for authentication and sending.
 * Returns the exact real SMTP outcome and logs complete diagnostics without leaking secrets.
 */
export async function sendShareEmail(options: SendShareEmailOptions): Promise<SendShareEmailResult> {
  const recipientEmail = (options.recipientEmail || options.to || "").trim().toLowerCase();
  const { senderName, senderEmail, fileName, fileSize, permission, expiresAt, shareUrl } = options;
  const passwordProtected = Boolean(options.passwordProtected || options.passwordRequired);

  const { transporter, host, port, user, passConfigured } = createPlatformTransporter();
  const senderAddress = (process.env.SMTP_FROM || user || "").trim();

  console.log("==================================================");
  console.log("[EmailService] OUTBOUND SHARE EMAIL ATTEMPT");
  console.log(`[EmailService] Recipient: ${recipientEmail}`);
  console.log(`[EmailService] Sender: ${senderAddress}`);
  console.log(`[EmailService] Sender Name: ${senderName} (${senderEmail || "N/A"})`);
  console.log(`[EmailService] SMTP Host: ${host}`);
  console.log(`[EmailService] SMTP Port: ${port}`);
  console.log(`[EmailService] SMTP User: ${user}`);
  console.log(`[EmailService] SMTP Password Configured: ${passConfigured ? "YES" : "NO"}`);
  console.log("==================================================");

  if (!recipientEmail) {
    const errorMsg = "Recipient email address is missing or empty.";
    console.error(`[EmailService] FAILED: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
      errorCode: "MISSING_RECIPIENT",
      recipient: "",
      sender: senderAddress,
      authSuccess: false,
    };
  }

  if (!passConfigured || !user) {
    const errorMsg = "SMTP server is not fully configured (missing SMTP_USER or SMTP_PASS).";
    console.error(`[EmailService] FAILED: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
      errorCode: "SMTP_UNCONFIGURED",
      recipient: recipientEmail,
      sender: senderAddress,
      authSuccess: false,
    };
  }

  // 1. Verify SMTP Authentication
  let authSuccess = false;
  try {
    const verified = await transporter.verify();
    authSuccess = Boolean(verified);
    console.log(`[EmailService] SMTP Authentication Succeeded: ${authSuccess}`);
  } catch (verifyErr: any) {
    authSuccess = false;
    const errCode = verifyErr.code || "AUTH_ERROR";
    const errMsg = verifyErr.message || "SMTP authentication failed.";
    console.error(`[EmailService] SMTP Authentication FAILED: [${errCode}] ${errMsg}`);
    console.error(`[EmailService] Response: ${verifyErr.response || "N/A"}`);
    
    return {
      success: false,
      error: `SMTP authentication failed: ${errMsg}`,
      errorCode: errCode,
      recipient: recipientEmail,
      sender: senderAddress,
      authSuccess: false,
    };
  }

  // 2. Prepare Email Content
  const expirationText = expiresAt 
    ? new Date(expiresAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
    : "Never expires";

  const safeSenderTitle = senderName || "A CloudVault user";

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px;">
        <div style="max-width: 580px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
          
          <!-- Header -->
          <div style="background-color: #2563eb; padding: 28px 32px; text-align: left;">
            <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;">CloudVault</h1>
            <p style="color: #bfdbfe; margin: 4px 0 0 0; font-size: 13px;">Secure File & Storage Platform</p>
          </div>

          <!-- Body -->
          <div style="padding: 32px;">
            <p style="font-size: 15px; color: #1e293b; margin: 0 0 16px 0; line-height: 1.5;">
              Hello,
            </p>
            <p style="font-size: 15px; color: #1e293b; margin: 0 0 24px 0; line-height: 1.5;">
              <strong>${safeSenderTitle}</strong> has shared a file with you on CloudVault.
            </p>
            
            <!-- Item Details Card -->
            <div style="background-color: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 0 0 24px 0;">
              <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <tr>
                  <td style="padding: 6px 0; color: #64748b; font-weight: 500; width: 110px;">Recipient:</td>
                  <td style="padding: 6px 0; color: #0f172a; font-weight: 600;">${recipientEmail}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #64748b; font-weight: 500;">File:</td>
                  <td style="padding: 6px 0; color: #0f172a; font-weight: 600;">${fileName}</td>
                </tr>
                ${fileSize ? `
                <tr>
                  <td style="padding: 6px 0; color: #64748b; font-weight: 500;">Size:</td>
                  <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${formatBytes(fileSize)}</td>
                </tr>
                ` : ""}
                <tr>
                  <td style="padding: 6px 0; color: #64748b; font-weight: 500;">Permission:</td>
                  <td style="padding: 6px 0; color: #0f172a; font-weight: 600;">${permission}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #64748b; font-weight: 500;">Expiration:</td>
                  <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${expirationText}</td>
                </tr>
              </table>
            </div>

            ${passwordProtected ? `
              <!-- Password Notice (No Password Exposed) -->
              <div style="background-color: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 14px 18px; margin: 0 0 28px 0;">
                <p style="color: #1e40af; font-size: 13px; margin: 0; line-height: 1.5; font-weight: 500;">
                  🔒 <strong>Password Protected:</strong> This item is protected with a password. Please enter the password provided directly by the sender to unlock and view it.
                </p>
              </div>
            ` : ""}

            <!-- Action Button -->
            <div style="text-align: center; margin: 32px 0 24px 0;">
              <a href="${shareUrl}" style="background-color: #2563eb; color: #ffffff; padding: 14px 32px; border-radius: 10px; text-decoration: none; font-weight: 600; display: inline-block; font-size: 15px; box-shadow: 0 2px 4px rgba(37, 99, 235, 0.2);">
                Open Shared File
              </a>
            </div>

            <!-- Fallback URL -->
            <p style="color: #64748b; font-size: 12px; margin: 24px 0 0 0; line-height: 1.5; text-align: center; word-break: break-all;">
              Or copy and paste this link into your browser:<br>
              <a href="${shareUrl}" style="color: #2563eb; text-decoration: underline;">${shareUrl}</a>
            </p>
          </div>

          <!-- Footer -->
          <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 32px; text-align: center;">
            <p style="color: #94a3b8; font-size: 12px; margin: 0;">
              This is an automated notification from CloudVault. If you did not expect this file, you can safely ignore this email.
            </p>
          </div>

        </div>
      </body>
    </html>
  `;

  const plainText = [
    `CloudVault - Secure File Share`,
    ``,
    `${safeSenderTitle} has shared a file with you on CloudVault.`,
    ``,
    `File: ${fileName}`,
    fileSize ? `Size: ${formatBytes(fileSize)}` : null,
    `Permission: ${permission}`,
    `Expiration: ${expirationText}`,
    passwordProtected ? `Password Protected: Yes (A password from the sender is required to access this file)` : null,
    ``,
    `Access Link: ${shareUrl}`,
    ``,
    `If you were not expecting this email, you can safely ignore it.`,
  ].filter(Boolean).join("\n");

  // 3. Dispatch Email via Nodemailer strictly to recipientEmail
  try {
    const info = await transporter.sendMail({
      from: `"CloudVault" <${senderAddress}>`,
      to: recipientEmail,
      subject: `You have access to ${fileName} on CloudVault`,
      text: plainText,
      html,
    });

    console.log("==================================================");
    console.log("[EmailService] NODEMAILER DISPATCH RESULT");
    console.log(`[EmailService] Nodemailer accepted: ${JSON.stringify(info.accepted)}`);
    console.log(`[EmailService] Nodemailer rejected: ${JSON.stringify(info.rejected)}`);
    console.log(`[EmailService] Nodemailer response: ${info.response}`);
    console.log(`[EmailService] Nodemailer messageId: ${info.messageId}`);
    console.log("==================================================");

    const acceptedList: string[] = Array.isArray(info.accepted) ? info.accepted.map((a: any) => (typeof a === "string" ? a : a?.address || "")) : [];
    const rejectedList: string[] = Array.isArray(info.rejected) ? info.rejected.map((r: any) => (typeof r === "string" ? r : r?.address || "")) : [];

    const isRecipientAccepted = acceptedList.some(
      (acc) => acc.toLowerCase().trim() === recipientEmail || recipientEmail.includes(acc.toLowerCase().trim())
    );
    const isRecipientRejected = rejectedList.some(
      (rej) => rej.toLowerCase().trim() === recipientEmail || recipientEmail.includes(rej.toLowerCase().trim())
    );

    if (isRecipientAccepted && !isRecipientRejected) {
      return {
        success: true,
        messageId: info.messageId,
        accepted: acceptedList,
        rejected: rejectedList,
        response: info.response,
        sender: senderAddress,
        recipient: recipientEmail,
        authSuccess: true,
      };
    } else {
      const rejectReason = isRecipientRejected 
        ? `Recipient ${recipientEmail} was rejected by SMTP server.`
        : `SMTP server did not confirm acceptance for recipient ${recipientEmail}.`;
      
      console.warn(`[EmailService] SMTP Dispatch Warning: ${rejectReason}`);
      return {
        success: false,
        error: rejectReason,
        errorCode: "RECIPIENT_NOT_ACCEPTED",
        accepted: acceptedList,
        rejected: rejectedList,
        response: info.response,
        sender: senderAddress,
        recipient: recipientEmail,
        authSuccess: true,
      };
    }
  } catch (sendErr: any) {
    const errCode = sendErr.code || "SEND_ERROR";
    const errMsg = sendErr.message || "Failed to deliver email through SMTP server.";
    console.error("==================================================");
    console.error(`[EmailService] NODEMAILER SEND ERROR: [${errCode}] ${errMsg}`);
    console.error(`[EmailService] Command: ${sendErr.command || "N/A"}`);
    console.error(`[EmailService] Response: ${sendErr.response || "N/A"}`);
    console.error("==================================================");

    return {
      success: false,
      error: `Email delivery failed: ${errMsg}`,
      errorCode: errCode,
      sender: senderAddress,
      recipient: recipientEmail,
      authSuccess: true,
    };
  }
}
