const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  "https://cncpymfqefyabiclnqzg.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNuY3B5bWZxZWZ5YWJpY2xucXpnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4Mjg3MDM2NywiZXhwIjoyMDk4NDQ2MzY3fQ.g8m820mqDLnyPBt3O3o2tCEYH26X8TiTfQXsGeeq7jM"
)

module.exports = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('memories')
      .select('*')
      .limit(10)

    res.status(200).json({ data, error })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
