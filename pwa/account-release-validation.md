# Direct Account Release Validation

The public Render service is healthy and connected to its database after the direct email-and-password account deployment.

The public NextAuth provider endpoint exposes the credentials provider with HTTPS sign-in and callback URLs on `https://pricecheck-backend-7tkh.onrender.com`, rather than a localhost address. The registration endpoint rejects malformed data with HTTP 400, and a valid-formatted unknown user receives HTTP 401 from login without creating test production data.

Google OAuth and SMTP remain intentionally deferred. The custom-domain task is deferred at the user’s request.
