const svc = require('./supabaseService');

async function update() {
    try {
        const { data, error } = await svc.supabase
            .from('auto_settings')
            .update({ ai_confidence_threshold: 65 })
            .eq('is_auto_active', true);
        
        if (error) throw error;
        console.log('AI Confidence Threshold updated to 65% for all active users.');
    } catch (e) {
        console.error(e);
    }
}

update();
