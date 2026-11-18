'use strict';
const bcrypt = require('bcryptjs');
const { q, getSetting, setSetting } = require('./db');
const { randomCode, otp4 } = require('./lib');

const CATEGORIES = [
  ['maths', 'Mathematics', 'Academics', '➗'], ['science', 'Science', 'Academics', '🔬'], ['physics', 'Physics', 'Academics', '⚛️'],
  ['chemistry', 'Chemistry', 'Academics', '🧪'], ['biology', 'Biology', 'Academics', '🧬'], ['english', 'English', 'Languages', '📖'],
  ['hindi', 'Hindi', 'Languages', '🅷'], ['kannada', 'Kannada', 'Languages', '🅺'], ['social', 'Social Studies', 'Academics', '🌍'],
  ['all-subjects', 'All Subjects (Primary)', 'Academics', '📚'], ['spoken-english', 'Spoken English', 'Languages', '🗣️'],
  ['drawing', 'Drawing & Painting', 'Arts', '🎨'], ['craft', 'Art & Craft', 'Arts', '✂️'], ['handwriting', 'Handwriting', 'Arts', '✍️'],
  ['singing', 'Singing (Vocal)', 'Music', '🎤'], ['carnatic', 'Carnatic Music', 'Music', '🎶'], ['keyboard', 'Keyboard / Piano', 'Music', '🎹'],
  ['guitar', 'Guitar', 'Music', '🎸'], ['bharatanatyam', 'Bharatanatyam', 'Dance', '💃'], ['western-dance', 'Western Dance', 'Dance', '🕺'],
  ['yoga', 'Yoga', 'Sports & Fitness', '🧘'], ['chess', 'Chess', 'Sports & Fitness', '♟️'], ['karate', 'Karate', 'Sports & Fitness', '🥋'],
  ['abacus', 'Abacus', 'Academics', '🧮'], ['coding', 'Coding for Kids', 'Technology', '💻'],
];

const DEFAULTS = {
  commission_percent: '15', search_radius_km: '3', referral_bonus_referrer: '10000', referral_bonus_referee: '5000',
  welcome_bonus: '0', admin_upi_id: 'edvitta@upi', admin_upi_name: 'Edvitta', helpline_phone: '',
  payment_gateway_enabled: '0', demo_payments_enabled: '0', email_enabled: '0', smtp_host: 'smtp.hostinger.com', smtp_port: '465',
  otp_login_enabled: '1', require_email_verification: '0', email_notifications_enabled: '1', mask_phone_numbers: '1', chat_enabled: '1',
  masked_calls_enabled: '0', video_enabled: '1', trial_enabled: '1', packages_enabled: '1', gst_enabled: '0', gst_percent: '18',
  staff_2fa_enabled: '1', student_absent_policy: 'makeup', tutor_leave_days_per_month: '4', parent_leave_days_per_booking: '6', weekly_payout_report_enabled: '1',
  auto_weekly_settlement: '0', whatsapp_enabled: '0', whatsapp_important_only: '1', whatsapp_template: 'edvitta_alert', whatsapp_template_lang: 'en',
  ad_price_home: '20000', ad_price_search: '15000', ad_price_community: '10000', ad_price_dashboard: '10000',
};

const PACKAGES = [['Starter: 8 classes', 8, 30, 5, '2 classes a week for a month'], ['Monthly: 12 classes', 12, 30, 8, '3 classes a week'],
  ['Pro: 20 classes', 20, 30, 12, '5 classes a week, best value'], ['Quarterly: 60 classes', 60, 90, 18, '3 months of 5 classes a week']];

function seedBase() {
  if (!q.get('SELECT 1 FROM packages')) for (const p of PACKAGES) q.run('INSERT INTO packages(name,sessions,validity_days,discount_percent,description) VALUES (?,?,?,?,?)', ...p);
  for (const c of CATEGORIES) q.run('INSERT OR IGNORE INTO categories(slug,name,grp,icon) VALUES (?,?,?,?)', ...c);
  for (const [k, v] of Object.entries(DEFAULTS)) if (getSetting(k) === undefined) setSetting(k, v);
  if (!q.get("SELECT 1 FROM users WHERE role='admin'")) {
    const email = (process.env.ADMIN_EMAIL || 'admin@edvitta.local').toLowerCase();
    // In production a known default password is never used: set ADMIN_PASSWORD, or a random one is generated and printed once.
    const pw = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === 'production' ? require('crypto').randomBytes(12).toString('base64url') + '9a' : 'Admin@12345');
    q.run("INSERT INTO users(role,name,email,phone,password_hash,referral_code) VALUES ('admin','Edvitta Admin',?,?,?,?)",
      email, process.env.ADMIN_PHONE || '9000000000', bcrypt.hashSync(pw, 12), 'ADMIN' + randomCode(4));
    console.log(`[edvitta] Admin account created: ${email} / ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : pw}  <- change this password after first login`);
  }
}

// Demo data around Koramangala, Bengaluru, so the 3 km search shows results straight away.
function seedDemo() {
  if (q.get("SELECT 1 FROM users WHERE email='parent@demo.in'")) return console.log('[edvitta] Demo data already present');
  const hash = bcrypt.hashSync('Demo@1234', 10);
  const add = (role, name, email, phone, extra = {}) => {
    const id = Number(q.run('INSERT INTO users(role,name,email,phone,password_hash,referral_code,wallet_balance,staff_permissions,email_verified) VALUES (?,?,?,?,?,?,?,?,1)',
      role, name, email, phone, hash, randomCode(8), extra.wallet || 0, extra.perms ? JSON.stringify(extra.perms) : null).lastInsertRowid);
    return id;
  };
  setSetting('demo_payments_enabled', '1'); // demo installs can top up instantly for testing
  const parent = add('parent', 'Priya Sharma', 'parent@demo.in', '9876500001', { wallet: 500000 });
  add('parent', 'Rahul Menon', 'parent2@demo.in', '9876500002', { wallet: 300000 });
  add('staff', 'Asha (Support)', 'staff@demo.in', '9876500009', { perms: ['tickets', 'kyc', 'payments', 'sos', 'bookings'] });
  q.run('INSERT INTO children(parent_id,name,grade,age) VALUES (?,?,?,?)', parent, 'Aarav', 'Class 5', 10);
  q.run('INSERT INTO children(parent_id,name,grade,age) VALUES (?,?,?,?)', parent, 'Diya', 'UKG', 5);
  const tutors = [
    ['Meera Iyer', 'tutor@demo.in', '9876500011', ['maths', 'science', 'abacus'], 35000, 'both', 12.9352, 77.6245, 'female', 'M.Sc Mathematics', 6],
    ['Arjun Rao', 'tutor2@demo.in', '9876500012', ['guitar', 'keyboard', 'singing'], 50000, 'both', 12.9279, 77.6271, 'male', 'Trinity Grade 8', 9],
    ['Kavya Nair', 'tutor3@demo.in', '9876500013', ['bharatanatyam', 'western-dance'], 45000, 'offline', 12.9401, 77.6190, 'female', 'Nritya Visharad', 7],
    ['Sana Khan', 'tutor4@demo.in', '9876500014', ['drawing', 'craft', 'handwriting'], 30000, 'both', 12.9310, 77.6150, 'female', 'BFA', 4],
    ['Vikram Shetty', 'tutor5@demo.in', '9876500015', ['english', 'spoken-english', 'coding'], 40000, 'online', 12.97, 77.64, 'male', 'B.Tech', 5],
  ];
  for (const [name, email, phone, cats, rate, mode, lat, lng, gender, qual, exp] of tutors) {
    const id = add('tutor', name, email, phone);
    q.run(`INSERT INTO tutor_profiles(user_id,bio,categories,experience_years,qualification,rate_per_session,mode,gender,lat,lng,address,available,kyc_status,police_verification,rating_sum,rating_count)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,'approved',1,?,?)`, id, `Friendly and patient ${qual} with ${exp} years of teaching children.`,
      JSON.stringify(cats), exp, qual, rate, mode, gender, lat, lng, 'Koramangala, Bengaluru', 9 + (id % 5), 2);
    q.run("UPDATE tutor_profiles SET background_check = ?, offers_trial = 1, trial_fee = ? WHERE user_id = ?", id % 2 ? 'clear' : 'in_progress', id % 3 ? 0 : 9900, id);
  }
  const pending = add('tutor', 'Nikhil Joshi', 'newtutor@demo.in', '9876500016');
  q.run(`INSERT INTO tutor_profiles(user_id,categories,lat,lng,address,kyc_status) VALUES (?,?,?,?,?,'not_submitted')`, pending, '["chess"]', 12.93, 77.62, 'HSR Layout, Bengaluru');
  q.run("INSERT OR IGNORE INTO coupons(code,type,value,max_discount,min_amount) VALUES ('WELCOME20','percent',20,50000,50000)");
  q.run("INSERT OR IGNORE INTO coupons(code,type,value,min_amount,per_user_limit) VALUES ('FLAT100','flat',10000,100000,3)");
  const now = Math.floor(Date.now() / 1000);
  q.run(`INSERT INTO ads(title,body,link,placement,days,price,status,starts_at,ends_at) VALUES
    ('Summer Art Camp 🎨','10-day creative camp for ages 6-12 in Koramangala. Early-bird 30% off!','https://example.com','home',30,0,'active',?,?),
    ('Little Einstein Science Kits','Hands-on science kits delivered home. Use code EDV10.','https://example.com','dashboard',30,0,'active',?,?),
    ('Prestige Apartments Dance Batch','Weekend Bharatanatyam batch starting soon in your society.','https://example.com','community',30,0,'active',?,?)`,
    now, now + 30 * 86400, now, now + 30 * 86400, now, now + 30 * 86400);
  q.run(`INSERT INTO community_groups(creator_id,name,apartment,category,grade,description,fee,max_members,schedule,lat,lng)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, parent, 'Class 5 Maths Batch', 'Prestige Acropolis, Koramangala', 'maths', 'Class 5',
    'Small batch for Class 5 kids in our apartment. Clubhouse, Mon/Wed/Fri 5-6 PM.', 150000, 8, 'Mon, Wed, Fri 5-6 PM', 12.9345, 77.6230);
  void otp4;
  console.log('[edvitta] Demo data added. Password for all demo accounts: Demo@1234');
}

module.exports = { seedBase, seedDemo };
if (require.main === module) {
  seedBase();
  if (process.argv.includes('--demo')) seedDemo();
}
