// 440+ Diverse International, Bangladeshi, and Indian Names
// With realistic casing variation (TitleCase, lowercase) and optional last names/initials

const FIRST_NAMES = [
  // --- Bangladeshi Names (85) ---
  "Tanvir", "Mehedi", "Shakib", "Rakib", "Fahim", "Naimur", "Ashik", "Shuvo", "Anik", "Sifat",
  "Sabbir", "Tamim", "Rifat", "Arafat", "Mahfuz", "Sohel", "Alamin", "Jahid", "Imran", "Nayem",
  "Shawon", "Maruf", "Emon", "Rabbi", "Arif", "Joy", "Hridoy", "Saiful", "Palash", "Ripon",
  "Shimul", "Sumon", "Biplob", "Faruk", "Monir", "Mizan", "Rubel", "Rasel", "Tarek", "Shamim",
  "Jewel", "Babu", "Liton", "Shahin", "Kamrul", "Bappy", "Sagar", "Rajib", "Munna", "Roni",
  "Sujon", "Kawsar", "Habibur", "Mostofa", "Nasir", "Delowar", "Ismail", "Mamun", "Parvez", "Tariqul",
  "Enamul", "Ashraful", "Mominul", "Soumya", "Mustafiz", "Taskin", "Shoriful", "Towhid", "Mahmudullah", "Sadia",
  "Nusrat", "Mim", "Samia", "Farzana", "Jannat", "Ritu", "Bristy", "Sharmin", "Nabila", "Tanjila",
  "Tasnim", "Lamia", "Afsana", "Sultana", "Ishrat",

  // --- Indian Names (85) ---
  "Rahul", "Rohan", "Aarav", "Aditya", "Vikram", "Rajesh", "Amit", "Arjun", "Rohit", "Deepak",
  "Suresh", "Priya", "Ananya", "Sneha", "Neha", "Pooja", "Anjali", "Riya", "Kavya", "Shreya",
  "Diya", "Ishaan", "Vihaan", "Reyansh", "Ayaan", "Krishna", "Shaurya", "Atharv", "Dhruv", "Kabir",
  "Aryan", "Advik", "Rudra", "Om", "Shivam", "Yash", "Harshit", "Ayush", "Alok", "Nikhil",
  "Mayank", "Prateek", "Gaurav", "Varun", "Manish", "Ankit", "Vishal", "Saurabh", "Pankaj", "Ashish",
  "Rakesh", "Manoj", "Sanjay", "Vijay", "Ajay", "Sandeep", "Dinesh", "Mukesh", "Ramesh", "Sunil",
  "Anil", "Vinod", "Ashok", "Sunita", "Geeta", "Rekha", "Anita", "Meena", "Swati", "Preeti",
  "Divya", "Deepika", "Radhika", "Tanvi", "Simran", "Harpreet", "Gurpreet", "Manpreet", "Navneet", "Jaspreet",
  "Karan", "Aakash", "Abhishek", "Chethan", "Devraj",

  // --- Western / English / US / UK Names (125) ---
  "Liam", "Noah", "Oliver", "James", "Elijah", "William", "Henry", "Lucas", "Benjamin", "Theodore",
  "Jack", "Levi", "Alexander", "Daniel", "Michael", "Mason", "Sebastian", "Logan", "David", "Julian",
  "Ethan", "Samuel", "Dylan", "Anthony", "Leo", "Owen", "Arthur", "Felix", "Oscar", "Finn",
  "Emma", "Olivia", "Ava", "Sophia", "Isabella", "Mia", "Amelia", "Harper", "Evelyn", "Abigail",
  "Emily", "Chloe", "Ella", "Scarlett", "Grace", "Victoria", "Aria", "Luna", "Stella", "Maya",
  "Alexa", "Hazel", "Violet", "Aurora", "Savannah", "Brooklyn", "Bella", "Claire", "Skylar", "Lucy",
  "Paisley", "Everly", "Anna", "Caroline", "Nova", "Genesis", "Kennedy", "Samantha", "Allison", "Sarah",
  "Madelyn", "Adeline", "Alex", "Sam", "Chris", "Jordan", "Taylor", "Morgan", "Cameron", "Casey",
  "Riley", "Avery", "Jesse", "Jamie", "Dakota", "Reese", "Quinn", "Peyton", "Charlie", "Blake",
  "Hayden", "Skyler", "Rowan", "Elliot", "Parker", "Eden", "River", "Sage", "Emerson", "Finley",
  "Sawyer", "Dallas", "Hunter", "Austin", "Cooper", "Ryder", "Colton", "Brody", "Bentley", "Jaxson",
  "Greyson", "Weston", "Harrison", "Declan", "Ezra", "Silas", "Miles", "Micah", "Jasper", "August",
  "Bennett", "Calvin", "Jonah", "Elliott", "Broderick",

  // --- European Names (German, French, Italian, Spanish, Nordic) (85) ---
  "Maximilian", "Lukas", "Leon", "Jonas", "Niklas", "Tobias", "Emil", "Jan", "Jakub", "Milan",
  "Gabriel", "Raphael", "Louis", "Antoine", "Mathis", "Hugo", "Jules", "Nico", "Clara", "Camille",
  "Matteo", "Leonardo", "Lorenzo", "Alessandro", "Federico", "Elena", "Chiara", "Giulia", "Sofia",
  "Carlos", "Diego", "Alejandro", "Javier", "Alvaro", "Santiago", "Valeria", "Lucia", "Marco", "Andrea",
  "Luca", "Enzo", "Paul", "Florian", "Philipp", "Simon", "Stefan", "Matthias", "Christian", "Patrick",
  "Fabio", "Dario", "Mario", "Roberto", "Giovanni", "Pietro", "Giorgio", "Antonio", "Domenico", "Salvatore",
  "Francesco", "Giuseppe", "Vincenzo", "Luigi", "Carmelo", "Fabrizio", "Massimo", "Paolo", "Alfonso", "Guillermo",
  "Esteban", "Fernando", "Gonzalo", "Ignacio", "Manuel", "Raul", "Rodrigo", "Sebastian", "Valentin", "Vicente",
  "Moritz", "Linus", "Valentin", "Hannes", "Fabian",

  // --- Diverse International Names (Middle Eastern, East Asian, African) (80) ---
  "Omar", "Tariq", "Zayn", "Rashid", "Kareem", "Ahmed", "Hamza", "Yusuf", "Farhan", "Samir",
  "Kenji", "Hiroshi", "Yuki", "Jun", "Ren", "Chen", "Wei", "Jun-seo", "Min-ho", "Ji-hoon",
  "Bilal", "Zaid", "Idris", "Mustafa", "Yaseen", "Kahlil", "Nader", "Fadi", "Bashir", "Latif",
  "Harun", "Dawood", "Mansoor", "Faisal", "Qasim", "Kazuki", "Daiki", "Sora", "Kaito", "Riku",
  "Yuto", "Hayato", "Haruto", "Sota", "Takumi", "Ming", "Hao", "Jie", "Bo", "Lei",
  "Tao", "Feng", "Long", "Qiang", "Peng", "Kwang", "Dong", "Hyun", "Seung", "Tae",
  "Woo", "Sung", "Jin", "Young", "Kwame", "Kofi", "Malik", "Amara", "Nia", "Jamal",
  "Jabari", "Tendai", "Sekou", "Babatunde", "Tenzin", "Kiran", "Naveen", "Lobsang", "Dawa", "Karma"
];

// Diverse Last Names across cultures
const LAST_NAMES = [
  // Western
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Wilson", "Anderson", "Taylor",
  "Thomas", "Moore", "Jackson", "Martin", "Lee", "White", "Harris", "Clark", "Lewis", "Robinson",
  "Walker", "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores",
  "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell", "Carter", "Roberts",
  // Bangladeshi / South Asian
  "Rahman", "Hasan", "Ahmed", "Islam", "Hossain", "Chowdhury", "Khan", "Uddin", "Ali", "Sikder",
  "Kazi", "Mia", "Talukder", "Mondol", "Bhuiyan", "Miah", "Sardar", "Howlader", "Sheikh", "Majumder",
  // Indian
  "Sharma", "Verma", "Gupta", "Patel", "Singh", "Kumar", "Mehta", "Joshi", "Reddy", "Nair",
  "Iyer", "Rao", "Chawla", "Bhatia", "Kapoor", "Malhotra", "Aggarwal", "Mishra", "Trivedi", "Pandey"
];

const LAST_INITIALS = [
  "A.", "B.", "C.", "D.", "E.", "F.", "G.", "H.", "J.", "K.", "L.", "M.",
  "N.", "P.", "R.", "S.", "T.", "V.", "W.", "Y.", "Z."
];

/**
 * Generates a realistic customer name with authentic casing and structure:
 * - Minimum 440+ unique first names
 * - Natural casing variation: Some TitleCase ("Sophia"), some lowercase ("alexander", "alexa")
 * - Last name variations:
 *   - ~45% No last name (Single name: e.g. "Sophia", "alexander", "Tanvir", "alexa")
 *   - ~35% First name + Initial (e.g. "Liam M.", "tanvir H.")
 *   - ~20% First name + Full last name (e.g. "Tanvir Rahman", "alexander Smith", "Aarav Sharma")
 */
function getRandomCustomerName() {
  const rawFirst = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  
  // Random casing: ~50% TitleCase (Sophia, Tanvir), ~50% lowercase (alexander, alexa, sumon)
  const isLower = Math.random() < 0.50;
  const firstName = isLower ? rawFirst.toLowerCase() : rawFirst;

  const styleRoll = Math.random();

  // 45% chance: Single name only (no last name)
  if (styleRoll < 0.45) {
    return firstName;
  }

  // 35% chance: First name + Initial
  if (styleRoll < 0.80) {
    const initial = LAST_INITIALS[Math.floor(Math.random() * LAST_INITIALS.length)];
    const finalInitial = isLower && Math.random() < 0.3 ? initial.toLowerCase() : initial;
    return `${firstName} ${finalInitial}`;
  }

  // 20% chance: First name + Full last name
  const rawLast = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  const lastName = isLower && Math.random() < 0.3 ? rawLast.toLowerCase() : rawLast;
  return `${firstName} ${lastName}`;
}

module.exports = {
  FIRST_NAMES,
  LAST_NAMES,
  LAST_INITIALS,
  getRandomCustomerName
};

