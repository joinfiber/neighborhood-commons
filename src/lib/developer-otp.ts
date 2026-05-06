/**
 * Developer OTP helpers — shared between browse-tier and service-tier
 * self-service registration.
 *
 * Uses the dedicated `developer_otps` table + Mailgun. NOT Supabase Auth
 * (which is reserved for Merrie user sessions).
 */

import { randomInt, timingSafeEqual } from 'crypto';
import { supabaseAdmin } from './supabase.js';
import { sendEmail } from './email.js';

const OTP_TTL_MINUTES = 10;

/** Generate an 8-digit numeric code. */
export function generateOtpCode(): string {
  return String(randomInt(10_000_000, 99_999_999));
}

/** Store an OTP code for the given email. Cleans up any prior codes. */
export async function storeOtp(email: string): Promise<string> {
  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();

  await supabaseAdmin
    .from('developer_otps')
    .delete()
    .eq('email', email.toLowerCase());

  const { error } = await supabaseAdmin
    .from('developer_otps')
    .insert({ email: email.toLowerCase(), code, expires_at: expiresAt });

  if (error) {
    throw new Error('Failed to store OTP');
  }

  return code;
}

/** Verify an OTP code. Returns true on match. Deletes the code on success or expiry. */
export async function verifyOtp(email: string, token: string): Promise<boolean> {
  const { data: otp } = await supabaseAdmin
    .from('developer_otps')
    .select('id, code, expires_at')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (!otp) return false;
  if (new Date(otp.expires_at) < new Date()) {
    await supabaseAdmin.from('developer_otps').delete().eq('id', otp.id);
    return false;
  }

  const match = otp.code.length === token.length &&
    timingSafeEqual(Buffer.from(otp.code), Buffer.from(token));
  if (!match) return false;

  await supabaseAdmin.from('developer_otps').delete().eq('id', otp.id);
  return true;
}

/** Send the OTP email. */
export async function sendOtpEmail(email: string, code: string): Promise<void> {
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <div style="font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; color: #7a7670; margin-bottom: 24px;">
        Neighborhood Commons
      </div>
      <div style="font-size: 16px; color: #37352f; line-height: 1.6; margin-bottom: 24px;">
        Your verification code is:
      </div>
      <div style="font-size: 32px; font-weight: 600; letter-spacing: 6px; color: #1a1917; font-family: monospace; margin-bottom: 24px;">
        ${code}
      </div>
      <div style="font-size: 14px; color: #6b6660; line-height: 1.6;">
        Enter this code to complete your registration. It expires in ${OTP_TTL_MINUTES} minutes.
      </div>
      <div style="font-size: 13px; color: #9c9791; margin-top: 32px;">
        If you didn't request this, you can ignore this email.
      </div>
    </div>
  `;
  await sendEmail(email, 'Your Neighborhood Commons verification code', html);
}
