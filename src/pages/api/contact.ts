import type { APIRoute } from 'astro';
import nodemailer from 'nodemailer';

// Force this route to be server-rendered
export const prerender = false;

// Types
interface ContactFormData {
  name: string;
  email: string;
  message: string;
  subject?: string;
}

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  data: ContactFormData | null;
}

// Rate limiting storage (in-memory, resets on deployment)
const submissions = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_SUBMISSIONS = 3; // max submissions per window

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const userSubmissions = submissions.get(ip) || [];
  
  // Clean old submissions
  const recentSubmissions = userSubmissions.filter(
    (timestamp: number) => now - timestamp < RATE_LIMIT_WINDOW
  );
  
  submissions.set(ip, recentSubmissions);
  
  return recentSubmissions.length >= MAX_SUBMISSIONS;
}

function addSubmission(ip: string): void {
  const userSubmissions = submissions.get(ip) || [];
  userSubmissions.push(Date.now());
  submissions.set(ip, userSubmissions);
}

// Input validation and sanitization
function validateAndSanitize(data: any): ValidationResult {
  const errors: string[] = [];
  
  // Required fields validation
  if (!data.name?.trim()) {
    errors.push('Name is required');
  } else if (data.name.trim().length < 2 || data.name.trim().length > 100) {
    errors.push('Name must be between 2 and 100 characters');
  }
  
  if (!data.email?.trim()) {
    errors.push('Email is required');
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) {
    errors.push('Valid email is required');
  }
  
  if (!data.message?.trim()) {
    errors.push('Message is required');
  } else if (data.message.trim().length < 10 || data.message.trim().length > 1000) {
    errors.push('Message must be between 10 and 1000 characters');
  }
  
  // Check for potential spam patterns
  const spamPatterns = [
    /<script/i,
    /javascript:/i,
    /onclick/i,
    /onload/i,
    /\[url=/i,
    /\[link=/i
  ];
  
  const allText = `${data.name} ${data.email} ${data.message}`;
  if (spamPatterns.some(pattern => pattern.test(allText))) {
    errors.push('Invalid content detected');
  }
  
  if (errors.length > 0) {
    return { isValid: false, errors, data: null };
  }
  
  return {
    isValid: true,
    errors: [],
    data: {
      name: data.name.trim(),
      email: data.email.trim().toLowerCase(),
      message: data.message.trim(),
      subject: data.subject?.trim() || 'New Contact Form Submission'
    }
  };
}

// Email transporter
function createTransporter() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // use TLS
    auth: {
      user: import.meta.env.GMAIL_USER,
      pass: import.meta.env.GMAIL_APP_PASSWORD
    }
  });
}

// Email content
function generateEmailContent(data: ContactFormData) {
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #f4f4f4; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
        .content { background-color: #ffffff; padding: 20px; border: 1px solid #ddd; border-radius: 5px; }
        .field { margin-bottom: 15px; }
        .label { font-weight: bold; color: #555; }
        .message-box { background-color: #f9f9f9; padding: 15px; border-left: 4px solid #f8a910; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>New Contact Form Message</h2>
          <p>New message from portfolio contact form.</p>
        </div>
        <div class="content">
          <div class="field">
            <div class="label">Name:</div>
            <div>${data.name}</div>
          </div>
          <div class="field">
            <div class="label">Email:</div>
            <div>${data.email}</div>
          </div>
          <div class="field">
            <div class="label">Subject:</div>
            <div>${data.subject}</div>
          </div>
          <div class="field">
            <div class="label">Message:</div>
            <div class="message-box">${data.message.replace(/\n/g, '<br>')}</div>
          </div>
        </div>
        <div style="margin-top: 20px; font-size: 12px; color: #666;">
          <p>This message was sent from the contact form at ${new Date().toLocaleString()}.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const textContent = `
New Contact Form Submission

Name: ${data.name}
Email: ${data.email}
Subject: ${data.subject}

Message:
${data.message}

Sent: ${new Date().toLocaleString()}
  `;

  return { html: htmlContent, text: textContent };
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  try {
    // Get client IP for rate limiting
    const clientIP = clientAddress || 
                    request.headers.get('x-forwarded-for') || 
                    request.headers.get('x-real-ip') ||
                    request.headers.get('cf-connecting-ip') || // Cloudflare
                    '127.0.0.1';

    console.log('Development - Client IP:', clientIP); // Debug log for localhost testing

    // Check rate limiting
    if (isRateLimited(clientIP)) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Too many submissions. Please try again later.' 
        }),
        { 
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    // Check environment variables
    if (!import.meta.env.GMAIL_USER || !import.meta.env.GMAIL_APP_PASSWORD) {
      console.error('Missing email configuration. Please check your .env file.');
      console.error('GMAIL_USER:', import.meta.env.GMAIL_USER ? 'Set' : 'Missing');
      console.error('GMAIL_APP_PASSWORD:', import.meta.env.GMAIL_APP_PASSWORD ? 'Set' : 'Missing');
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Server configuration error' 
        }),
        { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    // Parse form data
    let formData: Record<string, any>;
    const contentType = request.headers.get('content-type');
    
    if (contentType?.includes('application/json')) {
      formData = await request.json();
    } else if (contentType?.includes('multipart/form-data') || contentType?.includes('application/x-www-form-urlencoded')) {
      const data = await request.formData();
      formData = Object.fromEntries(data.entries());
    } else {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Invalid content type' 
        }),
        { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    const validation = validateAndSanitize(formData);
    if (!validation.isValid || !validation.data) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Validation failed', 
          details: validation.errors 
        }),
        { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    const sanitizedData = validation.data;

    // Create transporter and verify connection
    const transporter = createTransporter();
    
    try {
      console.log('Development - Testing SMTP connection...');
      await transporter.verify();
      console.log('Development - SMTP connection successful');
    } catch (verifyError) {
      console.error('SMTP connection failed:', verifyError);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Email service unavailable' 
        }),
        { 
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    const emailContent = generateEmailContent(sanitizedData);

    // Email options
    const mailOptions = {
      from: `"${sanitizedData.name}" <${import.meta.env.GMAIL_USER}>`,
      to: import.meta.env.CONTACT_EMAIL_TO || import.meta.env.GMAIL_USER,
      replyTo: sanitizedData.email,
      subject: `Portfolio Contact: ${sanitizedData.subject}`,
      text: emailContent.text,
      html: emailContent.html
    };

    // Send email
    console.log('Development - Sending email...');
    const info = await transporter.sendMail(mailOptions);
    console.log('Development - Email sent successfully:', info.messageId);
    console.log('Development - Email details:', {
      from: mailOptions.from,
      to: mailOptions.to,
      subject: mailOptions.subject
    });

    // Add to rate limiting after successful send
    addSubmission(clientIP);

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Email sent successfully' 
      }),
      { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error('Email sending error:', error);
    
    // Return generic error to client
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: 'Failed to send message. Please try again later.' 
      }),
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
};

// Handle other HTTP methods
export const GET: APIRoute = async () => {
  return new Response(
    JSON.stringify({ error: 'Method not allowed' }),
    { 
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    }
  );
};