const mongoose = require('mongoose');

const run = async () => {
    await mongoose.connect(process.env.DB_CONFIG, {
        useNewUrlParser: true,
        useUnifiedTopology: true
    }).then(() => {
        console.log('Connected to MongoDB')
    }).catch((err) => {
        console.log('Error:', err)
    })
}

module.exports = {run};