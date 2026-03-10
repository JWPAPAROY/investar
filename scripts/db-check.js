require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

async function test() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data } = await supabase.from('overnight_predictions').select('*').order('prediction_date', { ascending: false }).limit(2);
    console.log(JSON.stringify(data, null, 2));
}

test();
