import nodemailer from "nodemailer";

function getTransport() {
  const { EMAIL_HOST, EMAIL_USER, EMAIL_PASSWORD, EMAIL_FROM } = process.env;
  if (!EMAIL_HOST || !EMAIL_USER || !EMAIL_PASSWORD || !EMAIL_FROM) throw new Error("Transactional email is not configured");
  return nodemailer.createTransport({ host: EMAIL_HOST, port: Number(process.env.EMAIL_PORT || 587), secure: process.env.EMAIL_PORT === "465", auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD } });
}

export const emailService = {
  async sendVerificationOTP(name: string, email: string, otp: string): Promise<void> {
    await getTransport().sendMail({
      from: process.env.EMAIL_FROM, to: email, subject: "Verify your FitOS account",
      text: `Hi ${name},\n\nYour FitOS verification code is:\n\n${otp}\n\nThis code expires in 10 minutes.\n\nIf you did not request this code, you can safely ignore this email.\n\nRegards,\nFitOS Team`,
    });
  },
  async sendPasswordResetOTP(name: string, email: string, otp: string): Promise<void> {
    await getTransport().sendMail({ from: process.env.EMAIL_FROM, to: email, subject: "Reset your FitOS password", text: `Hi ${name},\n\nYour FitOS password reset code is:\n\n${otp}\n\nThis code expires in 10 minutes. If you did not request it, ignore this email.\n\nFitOS Team` });
  },
};
