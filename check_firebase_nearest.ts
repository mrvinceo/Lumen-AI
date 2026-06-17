import * as fs from 'firebase/firestore';
console.log('Firestore keys:', Object.keys(fs).filter(k => k.toLowerCase().includes('nearest')));
