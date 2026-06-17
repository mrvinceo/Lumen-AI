import * as fs from 'firebase/firestore';
const keys = Object.keys(fs).sort();
console.log('All Firestore keys:');
keys.forEach(k => console.log(k));
