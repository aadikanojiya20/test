const nodemailer = require('nodemailer');

const requiredEnv = ['EMAIL_USER', 'CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);

const transporter = missingEnv.length
    ? null
    : nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        connectionTimeout: 15000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        auth: {
            type: 'OAuth2',
            user: process.env.EMAIL_USER,
            clientId: process.env.CLIENT_ID,
            clientSecret: process.env.CLIENT_SECRET,
            refreshToken: process.env.REFRESH_TOKEN,
        },
    });

async function verifyTransporter() {
    if (!transporter) {
        throw new Error(`Email service is not configured. Missing env vars: ${missingEnv.join(', ')}`);
    }

    try {
        await transporter.verify();
        console.log('Email server is ready to send messages');
    } catch (error) {
        console.error('Error connecting to email server:', error);
        throw error;
    }
}

// Function to send email
const sendEmail = async (to, subject, text, html) => {
    if (!transporter) {
        throw new Error(`Email service is not configured. Missing env vars: ${missingEnv.join(', ')}`);
    }

    try {
        const info = await transporter.sendMail({
            from: `"Backend Ledger" <${process.env.EMAIL_USER}>`,
            to,
            subject,
            text,
            html,
        });

        console.log('Message sent: %s', info.messageId);
        return info;
    } catch (error) {
        console.error('Error sending email:', error);
        throw error;
    }
};


async function sendRegistrationEmail(userEmail, name) {
    const subject = 'Welcome to Backend Ledger!';
    const text = `Hello ${name},\n\nThank you for registering at Backend Ledger. We're excited to have you on board!\n\nBest regards,\nThe Backend Ledger Team`;
    const html = `<p>Hello ${name},</p><p>Thank you for registering at Backend Ledger. We're excited to have you on board!</p><p>Best regards,<br>The Backend Ledger Team</p>`;

    await sendEmail(userEmail, subject, text, html);
}

async function sendTransactionEmail(userEmail, name, amount, toAccount) {
    const subject = 'Transaction Successful!';
    const text = `Hello ${name},\n\nYour transaction of $${amount} to account ${toAccount} was successful.\n\nBest regards,\nThe Backend Ledger Team`;
    const html = `<p>Hello ${name},</p><p>Your transaction of $${amount} to account ${toAccount} was successful.</p><p>Best regards,<br>The Backend Ledger Team</p>`;

    await sendEmail(userEmail, subject, text, html);
}

async function sendTransactionFailureEmail(userEmail, name, amount, toAccount) {
    const subject = 'Transaction Failed';
    const text = `Hello ${name},\n\nWe regret to inform you that your transaction of $${amount} to account ${toAccount} has failed. Please try again later.\n\nBest regards,\nThe Backend Ledger Team`;
    const html = `<p>Hello ${name},</p><p>We regret to inform you that your transaction of $${amount} to account ${toAccount} has failed. Please try again later.</p><p>Best regards,<br>The Backend Ledger Team</p>`;

    await sendEmail(userEmail, subject, text, html);
}

module.exports = {
    sendRegistrationEmail,
    sendTransactionEmail,
    sendTransactionFailureEmail
};