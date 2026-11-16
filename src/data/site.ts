// Everything a non-developer is likely to edit lives here.

export const SITE = {
  name: 'RuRobotics',
  title: 'RuRobotics — The physical AI brain for the robots factories already own',
  description:
    'RuRobotics is the physical AI brain for the robots factories already own. Now expanding to New York and New Jersey. Robots as a service, per mission: diagnose, simulate, run, learn.',
  shareTitle: 'RuRobotics — Physical AI for the robots you already own',
  shareDescription: 'Your factory already has robots. We make them think. Robots as a service, per mission.',
  email: 'nawar.sgier013@gmail.com',
  linkedin: 'https://www.linkedin.com/in/nawar-sgier-24269519b/',
  x: 'https://x.com/RuRoboticsac',
  xHandle: '@RuRoboticsac',
  github: 'https://github.com/nawar21/RuRobotics',
};

export const NAV = [
  { href: '#nyc', label: 'New York' },
  { href: '#video', label: 'Video' },
  { href: '#twin', label: 'Digital twin' },
  { href: '#how', label: 'How it works' },
  { href: '#customers', label: 'Customers' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#team', label: 'Team' },
  { href: '#contact', label: 'Contact' },
];

export const NYC_FACTS = [
  { k: 'Where', v: 'New York & New Jersey' },
  { k: 'Who', v: 'Plastics, packaging, food & contract manufacturing' },
  { k: 'What', v: 'Paid pilots on your existing UR, KUKA or FANUC arms' },
  { k: 'When', v: 'Booking pilots now for 2026–2027' },
];

export const PROBLEMS = [
  {
    title: 'They bought one. It does one job.',
    body: 'Years later it is still doing that one job, because changing it means an integrator, months, and a new bill.',
  },
  {
    title: 'Changing the job costs more than the robot did.',
    body: 'A $35k arm becomes a $60k+ project once it is integrated — and the bill restarts every time the product changes.',
  },
  {
    title: 'Nobody wants to hire for the repetitive work.',
    body: 'The hardware is on the floor. The people to run the dull stations are not. The intelligence is what is missing.',
  },
];

export const SOLUTION_CHIPS = [
  { value: 'Days', label: 'to go live' },
  { value: '0', label: 'new robots to buy' },
  { value: '1×', label: 'a mistake happens once' },
];

export type StepIcon = 'diagnose' | 'simulate' | 'run' | 'learn';
export const STEPS: { icon: StepIcon; title: string; body: string }[] = [
  {
    icon: 'diagnose',
    title: 'Diagnose',
    body: 'We walk your floor with you, pick the mission that hurts most, and agree the KPIs before anything moves.',
  },
  {
    icon: 'simulate',
    title: 'Simulate',
    body: 'Our cameras map your line and parts. The mission is planned and proven in simulation first — no production downtime.',
  },
  { icon: 'run', title: 'Run', body: 'Your robot does the job on the real line. Live in days, not months.' },
  {
    icon: 'learn',
    title: 'Learn',
    body: 'When something goes wrong, it remembers. It won’t do it twice. The robot gets more reliable every shift.',
  },
];

export const CUSTOMERS = [
  { name: 'Keter', body: 'Plastics. One crate-handling mission. 3-month pilot, then a 2-year contract.' },
  { name: 'Roushali Bakery', body: 'Industrial bakery. One tray-loading mission. 3-month pilot, then a 2-year contract.' },
  { name: 'Strauss', body: 'The “Nestlé of Israel.” In discussion about a rollout across every department.' },
];

export const PRICING = [
  { title: 'To sign', stat: '$3,000', unit: 'once', body: 'When the contract is signed.' },
  { title: 'Hardware', stat: 'At cost', unit: 'no markup', body: 'A Jetson and a camera or two. Nothing if you already have them.' },
  {
    title: 'Per mission · pilot',
    stat: '$2,500',
    unit: 'per month',
    body: 'For the 3-month pilot. After that, the 2-year contract is priced on what the mission is worth to you.',
  },
];

export type Person = { initials: string; name: string; role: string; creds: string[]; linkedin?: string };

export const CORE_TEAM: Person[] = [
  {
    initials: 'NS',
    name: 'Nawar Sgier',
    role: 'CEO · Co-founder',
    creds: ['Technion CS + Mathematics', 'CGGC research · RL + 3D vision'],
    linkedin: 'https://www.linkedin.com/in/nawar-sgier-24269519b/',
  },
  {
    initials: 'SS',
    name: 'Subhi Salami',
    role: 'R&D · Co-founder',
    creds: ['Automation & robotics engineer', 'PLC · Siemens · Cognex · 5 years on factory floors'],
    linkedin: 'https://www.linkedin.com/in/subhisalami/',
  },
  {
    initials: 'MM',
    name: 'Mutaz Manaa',
    role: 'Motion planning',
    creds: ['Ran an algorithms team at Mobileye', 'Geometry · calibration · planning'],
  },
];

export const ADVISORS: Person[] = [
  {
    initials: 'SS',
    name: 'Sobhi Sgier',
    role: 'Finance & industry connections',
    creds: ['Campus Manager, Moona', 'Partnerships across northern industry'],
  },
  {
    initials: 'YH',
    name: 'Yoram Horowitz',
    role: 'Advisor · enterprise',
    creds: ['Former VP, SAP', 'Management and enterprise guidance'],
  },
];
