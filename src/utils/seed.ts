import mongoose from 'mongoose';
import { Quiz } from '../models/Quiz';
import { env } from '../config/env';

const MONGODB_URI = env.MONGODB_URI;

const defaultQuizzes = [
  {
    title: 'Current Affairs & Geography Trivia',
    description: 'Test your general knowledge with these 25 fun current affairs and world geography questions!',
    price: 0,
    isPublishedToMarketplace: false,
    isDefault: true,
    questions: [
      { question: 'Which country has the longest coastline in the world?', options: ['USA', 'Ghana', 'Nigeria', 'Canada'], correctOption: 'Canada', timeLimit: 10 },
      { question: 'What is the capital of Malta?', options: ['London', 'Valletta', 'Seoul', 'Rome'], correctOption: 'Valletta', timeLimit: 10 },
      { question: 'What is the biggest island in the world?', options: ['Greenland', 'Iceland', 'Madagascar', 'Australia'], correctOption: 'Greenland', timeLimit: 10 },
      { question: 'Which city currently has the highest population in the world?', options: ['New York', 'Shanghai', 'Tokyo', 'Mumbai'], correctOption: 'Tokyo', timeLimit: 10 },
      { question: 'What is the highest mountain peak in Africa?', options: ['Mount Kenya', 'Oke Olumo', 'Mount Kilimanjaro', 'Mount Everest'], correctOption: 'Mount Kilimanjaro', timeLimit: 10 },
      { question: 'What is the largest desert in the world?', options: ['Sahara', 'Gobi', 'Antarctica', 'Kalahari'], correctOption: 'Antarctica', timeLimit: 10 },
      { question: 'Which gas do plants absorb from the atmosphere during photosynthesis?', options: ['Carbon Dioxide', 'Oxygen', 'Nitrogen', 'Hydrogen'], correctOption: 'Carbon Dioxide', timeLimit: 10 },
      { question: 'In which US state would you find Harvard University?', options: ['Arizona', 'Texas', 'California', 'Massachusetts'], correctOption: 'Massachusetts', timeLimit: 10 },
      { question: 'How many large islands make up Hawaii?', options: ['Three', 'Four', 'Eight', 'Twelve'], correctOption: 'Eight', timeLimit: 10 },
      { question: 'What is the name of the microstate located between Spain and France?', options: ['Andorra', 'Monaco', 'San Marino', 'Liechtenstein'], correctOption: 'Andorra', timeLimit: 10 },
      { question: 'Which river is the longest in the world?', options: ['Amazon', 'Nile', 'Yangtze', 'Mississippi'], correctOption: 'Nile', timeLimit: 10 },
      { question: 'Which country is also known as the Land of the Rising Sun?', options: ['China', 'Japan', 'South Korea', 'Thailand'], correctOption: 'Japan', timeLimit: 10 },
      { question: 'What is the capital of Australia?', options: ['Sydney', 'Melbourne', 'Canberra', 'Brisbane'], correctOption: 'Canberra', timeLimit: 10 },
      { question: 'Which ocean is the largest in the world?', options: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], correctOption: 'Pacific', timeLimit: 10 },
      { question: 'What is the smallest country in the world by land area?', options: ['Monaco', 'Nauru', 'Vatican City', 'Tuvalu'], correctOption: 'Vatican City', timeLimit: 10 },
      { question: 'In which country is the ancient city of Petra located?', options: ['Egypt', 'Jordan', 'Greece', 'Turkey'], correctOption: 'Jordan', timeLimit: 10 },
      { question: 'What is the capital of Canada?', options: ['Toronto', 'Vancouver', 'Montreal', 'Ottawa'], correctOption: 'Ottawa', timeLimit: 10 },
      { question: 'Which African country has the largest population?', options: ['South Africa', 'Egypt', 'Nigeria', 'Ethiopia'], correctOption: 'Nigeria', timeLimit: 10 },
      { question: 'Which channel separates the United Kingdom from France?', options: ['Suez Canal', 'Panama Canal', 'English Channel', 'Gibraltar Strait'], correctOption: 'English Channel', timeLimit: 10 },
      { question: 'Which country has the most natural lakes in the world?', options: ['Russia', 'Canada', 'USA', 'Brazil'], correctOption: 'Canada', timeLimit: 10 },
      { question: 'What is the capital of South Korea?', options: ['Seoul', 'Tokyo', 'Beijing', 'Bangkok'], correctOption: 'Seoul', timeLimit: 10 },
      { question: 'Which currency is used in Japan?', options: ['Yuan', 'Won', 'Yen', 'Ringgit'], correctOption: 'Yen', timeLimit: 10 },
      { question: 'What is the official language of Brazil?', options: ['Spanish', 'English', 'French', 'Portuguese'], correctOption: 'Portuguese', timeLimit: 10 },
      { question: 'Which mountain range runs along the western coast of South America?', options: ['Himalayas', 'Alps', 'Rockies', 'Andes'], correctOption: 'Andes', timeLimit: 10 },
      { question: 'What is the capital of Iceland?', options: ['Oslo', 'Reykjavik', 'Helsinki', 'Copenhagen'], correctOption: 'Reykjavik', timeLimit: 10 }
    ]
  },
  {
    title: 'Basic Software Development',
    description: 'Review your programming fundamentals, HTML, CSS, JavaScript, and Node.js concepts with these 25 questions!',
    price: 0,
    isPublishedToMarketplace: false,
    isDefault: true,
    questions: [
      { question: 'What does HTML stand for?', options: ['HighText Markup Language', 'HyperText Markup Language', 'HyperTabular Media Layout', 'Home Tool Markup Language'], correctOption: 'HyperText Markup Language', timeLimit: 15 },
      { question: 'Which JavaScript array method adds elements to the end of an array?', options: ['pop()', 'push()', 'shift()', 'unshift()'], correctOption: 'push()', timeLimit: 10 },
      { question: 'In CSS, what property is used to change the background color of an element?', options: ['color', 'bg-color', 'background-color', 'bgcolor'], correctOption: 'background-color', timeLimit: 10 },
      { question: 'Which of the following is NOT a JavaScript primitive data type?', options: ['String', 'Boolean', 'Object', 'Undefined'], correctOption: 'Object', timeLimit: 10 },
      { question: 'Which SQL keyword is used to retrieve data from a database?', options: ['SELECT', 'GET', 'RETRIEVE', 'FETCH'], correctOption: 'SELECT', timeLimit: 10 },
      { question: 'What command initializes a new Git repository in your terminal?', options: ['git create', 'git start', 'git init', 'git setup'], correctOption: 'git init', timeLimit: 10 },
      { question: 'What is the package manager that comes default with Node.js?', options: ['yarn', 'npm', 'pnpm', 'composer'], correctOption: 'npm', timeLimit: 10 },
      { question: 'In Node.js, what is the default import system used by standard modules?', options: ['CommonJS (require)', 'ES Modules (import)', 'AMD', 'RequireJS'], correctOption: 'CommonJS (require)', timeLimit: 15 },
      { question: 'Which HTTP status code represents a "Not Found" error?', options: ['200 OK', '400 Bad Request', '403 Forbidden', '404 Not Found'], correctOption: '404 Not Found', timeLimit: 10 },
      { question: 'Which MongoDB database method retrieves multiple documents matching a query?', options: ['find()', 'get()', 'query()', 'select()'], correctOption: 'find()', timeLimit: 10 },
      { question: 'What does CSS stand for?', options: ['Computer Style Sheets', 'Creative Style Sheets', 'Cascading Style Sheets', 'Colorful Style Sheets'], correctOption: 'Cascading Style Sheets', timeLimit: 10 },
      { question: 'Which operator is used for strict equality comparison in JavaScript?', options: ['=', '==', '===', '!='], correctOption: '===', timeLimit: 10 },
      { question: 'Which HTML tag is used to write client-side script code?', options: ['<css>', '<javascript>', '<script>', '<js>'], correctOption: '<script>', timeLimit: 10 },
      { question: 'What does API stand for?', options: ['Application Program Interface', 'Application Programming Interface', 'Applied Process Integration', 'Array Partition Index'], correctOption: 'Application Programming Interface', timeLimit: 10 },
      { question: 'Which of the following is a CSS layout framework?', options: ['Express', 'Bootstrap', 'MongoDB', 'Angular'], correctOption: 'Bootstrap', timeLimit: 10 },
      { question: 'What tag is used to insert an image in HTML?', options: ['<picture>', '<img>', '<src>', '<href>'], correctOption: '<img>', timeLimit: 10 },
      { question: 'Which data format is commonly used to transfer data over HTTP?', options: ['XML', 'JSON', 'HTML', 'CSV'], correctOption: 'JSON', timeLimit: 10 },
      { question: 'What does SQL stand for?', options: ['Structured Query Language', 'Simple Queue Layout', 'Standard Query List', 'Sequential Query Loop'], correctOption: 'Structured Query Language', timeLimit: 10 },
      { question: 'What does DOM stand for in web development?', options: ['Domain Object Model', 'Document Object Model', 'Digital Ordinance Map', 'Document Option Memory'], correctOption: 'Document Object Model', timeLimit: 10 },
      { question: 'Which keyword declares a block-scoped local variable in JavaScript?', options: ['var', 'let', 'global', 'local'], correctOption: 'let', timeLimit: 10 },
      { question: 'Which command updates dependencies in npm?', options: ['npm update', 'npm upgrade', 'npm install', 'npm restore'], correctOption: 'npm update', timeLimit: 10 },
      { question: 'What is the default port for local Express servers in many examples?', options: ['80', '443', '3000', '8080'], correctOption: '3000', timeLimit: 10 },
      { question: 'What HTML attribute is used to define inline styles?', options: ['class', 'style', 'font', 'styles'], correctOption: 'style', timeLimit: 10 },
      { question: 'Which package is commonly used to encrypt passwords in Node.js?', options: ['bcryptjs', 'crypto-js', 'jwt', 'hash'], correctOption: 'bcryptjs', timeLimit: 10 },
      { question: 'What tag creates a clickable hyperlink in HTML?', options: ['<link>', '<a>', '<href>', '<url>'], correctOption: '<a>', timeLimit: 10 }
    ]
  }
];

const seed = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB for seeding...');

    // Clear existing default quizzes
    await Quiz.deleteMany({ isDefault: true });
    console.log('Deleted existing default quizzes.');

    // Insert new default quizzes
    await Quiz.insertMany(defaultQuizzes);
    console.log('Inserted default Current Affairs and Software Development quizzes (25 questions each) successfully.');

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB. Seeding complete.');
    process.exit(0);
  } catch (error) {
    console.error('Error during seeding:', error);
    process.exit(1);
  }
};

seed();
