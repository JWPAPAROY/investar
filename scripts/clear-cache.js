require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

async function clearCache() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const today = kst.toISOString().slice(0, 10);

    console.log(`Clearing cache for: ${today}`);

    const { error } = await supabase
        .from('overnight_predictions')
        .delete()
        .eq('prediction_date', today);

    if (error) {
        console.error('Error clearing cache:', error.message);
    } else {
        console.log('Cache cleared successfully. Next API call will generate fresh data including AI interpretation.');
    }
}

clearCache();
