require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const supabase = require('../backend/supabaseClient');

async function check() {
    const { data, error } = await supabase.from('overnight_predictions').select('*').limit(1);
    console.log("Cols:", data ? Object.keys(data[0]) : error);
}
check();
