export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { username, password } = body || {};

    const validUser = process.env.LOGIN_USERNAME;
    const validPass = process.env.LOGIN_PASSWORD;
    const token = process.env.SHARED_TOKEN;

    if (!validUser || !validPass || !token) {
      return res.status(500).json({ error: 'Server is not configured for login yet.' });
    }

    if (username === validUser && password === validPass) {
      return res.status(200).json({ success: true, token });
    }

    return res.status(401).json({ error: 'Incorrect username or password.' });
  } catch (err) {
    return res.status(400).json({ error: 'Bad request.' });
  }
}
