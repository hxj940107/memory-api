export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ error: "Missing query" });
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results: 5
      })
    });

    const data = await response.json();

    res.status(200).json(data);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed" });
  }
}
