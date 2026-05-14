require('dotenv').config();
const crypto = require('crypto');
const supabaseService = require('./supabaseService'); // Using the existing supabase service

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return { salt, hash };
}

async function seedAdmin() {
    const email = 'admin@stockspro.com';
    const password = 'AdminPassword123!';
    const name = 'System Admin';

    try {
        console.log('Checking if admin user exists...');
        const existing = await supabaseService.getUserByEmail(email);
        
        if (existing) {
            console.log('Admin already exists! Ensuring role is set to ADMIN...');
            const { error } = await supabaseService.supabase
                .from('app_users')
                .update({ role: 'ADMIN', plan_tier: 'PRO' })
                .eq('id', existing.id);
            
            if (error) throw error;
            console.log('Admin role updated successfully!');
        } else {
            console.log('Creating new Admin user...');
            const { salt, hash } = hashPassword(password);
            
            await supabaseService.createUser({
                id: crypto.randomUUID(),
                name,
                email,
                password_salt: salt,
                password_hash: hash,
                role: 'ADMIN',
                plan_tier: 'PRO', // Admin gets PRO plan automatically
                created_at: new Date().toISOString()
            });
            console.log('Admin user seeded successfully!');
        }

        console.log('\n======================================');
        console.log('  👑 ADMIN CREDENTIALS');
        console.log('======================================');
        console.log(`  Email:    ${email}`);
        console.log(`  Password: ${password}`);
        console.log('======================================\n');
        
    } catch (e) {
        console.error('Error seeding admin:', e.message);
    }
}

seedAdmin();
