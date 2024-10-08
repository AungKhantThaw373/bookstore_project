require('dotenv').config();

const express = require('express');
const app = express();
const cors = require('cors');
const bodyParser = require('body-parser');
const pgp = require('pg-promise')();
const jwt = require('jsonwebtoken');
const PORT = process.env.PORT || 10000;
const multer = require('multer');
const streamifier = require('streamifier');
const { Buffer } = require('buffer');
const cloudinary = require('cloudinary').v2;

// Cloudinary configuration
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = multer.memoryStorage();
const upload = multer({ storage });
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(process.env.CLOUDINARY_CLOUD_NAME)
    console.log(process.env.CLOUDINARY_API_KEY)
    console.log(process.env.CLOUDINARY_API_SECRET)
});

const db = pgp(process.env.DATABASE_URL);


app.use(cors({
    origin: '*', // Allows all origins
    credentials: true // Ensures that credentials like cookies are included in requests
}));

app.use(bodyParser.json());

// Authenticate Token Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Extract Bearer token

    if (!token) return res.sendStatus(401);

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            console.error(err);
            return res.sendStatus(403);
        }
        req.user = user;
        next();
    });
};

//Register
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;

    try {
        // Define a list of admin usernames
        const adminUsernames = ['Admin1', 'Admin2', 'Admin3']; // Add your admin usernames here

        // Check if the username or email already exists
        const existingUser = await db.oneOrNone(
            'SELECT * FROM userz WHERE username = $1 OR email = $2',
            [username, email]
        );

        if (existingUser) {
            return res.status(400).json({ error: 'Username or email already in use' });
        }

        // Determine user role
        const role = adminUsernames.includes(username) ? 'admin' : 'user';

        // Insert new user
        const newUser = await db.one(
            'INSERT INTO userz (username, email, password, role) VALUES ($1, $2, $3, $4) RETURNING *',
            [username, email, password, role] // Make sure to hash the password before storing
        );

        res.status(201).json(newUser);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});


//Login
app.post('/api/login', async (req, res) => {
    const { identifier, password } = req.body;

    try {
        // Find user by username or email
        const user = await db.oneOrNone(
            'SELECT * FROM userz WHERE username = $1 OR email = $2',
            [identifier, identifier]
        );

        if (!user || user.password !== password) { // Use hashed passwords in production
            return res.status(401).json({ error: 'Invalid username/email or password' });
        }

        // Generate JWT token
        const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET);

        res.json({ token });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

//get users
app.get('/api/users', async (req, res) => {
    try {
        const users = await db.any('SELECT * FROM userz');

        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

//get user
app.get('/api/user', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        // Query the database to get user details
        const user = await db.oneOrNone('SELECT * FROM userz WHERE id = $1', [userId]);

        if (user) {
            return res.json({
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                profilePicUrl: user.profile_pic_url
                // Include any other fields you need
            });
        } else {
            return res.status(404).json({ error: 'User not found' });
        }
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

//Update profile
app.put('/api/profile/update', authenticateToken, upload.single('profile_pic'), async (req, res) => {
    console.log('Authenticated User:', req.user); // Debug log

    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'User not authenticated' });
    }

    const { username, email, currentPassword, newPassword } = req.body;

    console.log('Request Body:', { username, email, currentPassword, newPassword }); // Log the request body

    try {
        let profilePicUrl = null;

        if (req.file) {
            // Convert Buffer to Base64
            const base64Image = req.file.buffer.toString('base64');
            const mimeType = req.file.mimetype; // e.g., image/jpeg

            console.log('Image File:', { base64Image, mimeType }); // Log the image file details

            // Use Cloudinary unsigned upload
            const result = await new Promise((resolve, reject) => {
                cloudinary.uploader.unsigned_upload(
                    `data:${mimeType};base64,${base64Image}`,
                    'ouum5xwe',
                    { resource_type: 'image' },
                    (error, result) => {
                        if (error) return reject(error);
                        resolve(result);
                    }
                );
            });

            if (result && result.secure_url) {
                profilePicUrl = result.secure_url;
                console.log('Cloudinary Result:', result); // Log Cloudinary result
            } else {
                throw new Error('Image upload failed');
            }
        } else {
            // If no new image is uploaded, use the existing profile picture URL if provided
            profilePicUrl = req.body.profile_pic_url || null;
            console.log('No new image uploaded. Using existing profile picture URL:', profilePicUrl);
        }

        // Update user profile in the database
        await db.none(
            `UPDATE userz SET username=$1, email=$2, profile_pic_url=$3 WHERE id=$4`,
            [username, email, profilePicUrl, req.user.id]
        );

        res.json({
            username,
            email,
            profile_pic_url: profilePicUrl,
        });
    } catch (err) {
        console.error('Profile update error:', err); // Log errors
        res.status(500).json({ error: 'Profile update failed' });
    }
});

// Fetch reviews for a specific book with pagination
app.get('/api/books/:id/reviews', (req, res) => {
    const { id: book_id } = req.params;
    const { page = 1, limit = 10 } = req.query;

    // Ensure page and limit are integers
    const pageNumber = parseInt(page, 10);
    const reviewsPerPage = parseInt(limit, 10);

    if (isNaN(pageNumber) || isNaN(reviewsPerPage)) {
        return res.status(400).json({ error: 'Invalid page or limit' });
    }

    // Calculate the offset
    const offset = (pageNumber - 1) * reviewsPerPage;

    db.task(async t => {
        // Fetch reviews for the specified book with pagination
        const reviews = await t.any(`
            SELECT r.review_id, r.content, r.created_at, u.username, u.profile_pic_url, r.likes
            FROM reviews r
            JOIN userz u ON r.user_id = u.id
            WHERE r.book_id = $1
            ORDER BY r.created_at DESC
            LIMIT $2 OFFSET $3
        `, [book_id, reviewsPerPage, offset]);

        // Count the total number of reviews for pagination info
        const totalReviews = await t.one(`
            SELECT COUNT(*) as count
            FROM reviews
            WHERE book_id = $1
        `, [book_id]);

        return { reviews, totalReviews: totalReviews.count };
    })
        .then(data => {
            res.json(data);
        })
        .catch(err => {
            console.error(err);
            res.status(500).json({ error: 'Failed to fetch reviews' });
        });
});


// Update the likes of a review
app.post('/api/reviews/:review_id/like', (req, res) => {
    const { review_id } = req.params;

    // Check if review_id is a valid integer
    if (isNaN(parseInt(review_id, 10))) {
        return res.status(400).json({ error: 'Invalid review ID' });
    }

    db.none(`
        UPDATE reviews
        SET likes = likes + 1
        WHERE review_id = $1
    `, [parseInt(review_id, 10)])
        .then(() => {
            res.json({ success: true });
        })
        .catch(err => {
            console.error(err);
            res.status(500).json({ error: 'Failed to like review' });
        });
});




// Post a new review for a specific book
app.post('/api/books/:id/reviews', authenticateToken, (req, res) => {
    const { id: book_id } = req.params;
    const { content } = req.body;
    const user_id = req.user.id; // Assuming user_id is stored in req.user from the token

    db.none(`
        INSERT INTO reviews (book_id, user_id, content, created_at, updated_at)
        VALUES ($1, $2, $3, NOW(), NOW())
    `, [book_id, user_id, content])
        .then(() => {
            res.json({ message: 'Review added successfully!' });
        })
        .catch(err => {
            console.error(err);
            res.status(500).json({ error: 'Failed to post review' });
        });
});


// Get books
app.get('/api/books', async (req, res) => {
    try {
        const books = await db.any('SELECT * FROM books');

        // Format the book data
        const formattedBooks = books.map(book => ({
            id: book.id,
            isbn: book.isbn,
            title: book.title,
            author: book.author.join(', '), // Convert array to string
            genre: book.genre.join(', '), // Convert array to string
            price: parseFloat(book.price).toFixed(2), // Ensure price is a float and formatted
            image_url: book.image_url,
            description: book.description,
            username: book.username // Include the username
        }));

        res.json(formattedBooks);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get book by ISBN
app.get('/api/books/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const book = await db.one('SELECT * FROM books WHERE id = $1', [id]);
        book.author = book.author.join(', ');
        book.genre = book.genre.join(', ');
        res.json(book);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add a new book
app.post('/api/books', async (req, res) => {
    const { isbn, title, author, genre, price, image_url, description } = req.body;
    const username = req.body.username ? req.body.username : 'Admin'; // Default to 'Admin' if username is not available
    try {
        const newBook = await db.one(
            `INSERT INTO books (isbn, title, author, genre, price, image_url, description, username)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [isbn, title, author, genre, price, image_url, description, username]
        );
        res.status(201).json(newBook);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Add multiple books
app.post('/api/books/bulk', async (req, res) => {
    const books = req.body;
    const username = req.user ? req.user.username : 'Admin'; // Default to 'Admin' if username is not available

    // Validate that the books array is provided and is an array
    if (!Array.isArray(books)) {
        return res.status(400).json({ error: 'Invalid input: Expected an array of books' });
    }

    // Check that each book in the array has the required fields
    for (const book of books) {
        if (!book.isbn || !book.title || !book.price) {
            return res.status(400).json({ error: 'Each book must have an ISBN, title, and price' });
        }
    }

    try {
        // Use a transaction to ensure all books are inserted or none are inserted
        await db.tx(async (t) => {
            for (const book of books) {
                await t.none(
                    'INSERT INTO books (isbn, title, author, genre, price, image_url, description, username) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                    [book.isbn, book.title, book.author, book.genre, book.price, book.image_url, book.description, username]
                );
            }
        });

        res.status(201).json({ message: 'Books added successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update an existing book
app.put('/api/books/:id', async (req, res) => {
    const { id } = req.params;
    const { title, author, genre, price, image_url, description } = req.body;
    try {
        const updatedBook = await db.one(
            'UPDATE books SET title = $1, author = $2, genre = $3, price = $4, image_url = $5, description = $6 WHERE id = $7 RETURNING *',
            [title, author, genre, price, image_url, description, id]
        );
        res.json(updatedBook);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a book
app.delete('/api/books/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.none('DELETE FROM books WHERE id = $1', [id]);
        res.sendStatus(204);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete multiple books
app.post('/api/books/multiple', async (req, res) => {
    const { ids } = req.body;

    // Validate that ids is an array and contains elements
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'Invalid input: Expected an array of book IDs' });
    }

    try {
        // Convert all IDs to integers
        const integerIds = ids.map(id => parseInt(id, 10));

        // Check if all IDs are valid integers
        if (integerIds.some(isNaN)) {
            return res.status(400).json({ error: 'Invalid input: All IDs must be integers' });
        }

        // Delete books using the ANY() clause with an integer array
        await db.none('DELETE FROM books WHERE id = ANY($1::int[])', [integerIds]);

        res.status(200).json({ message: 'Books deleted successfully' });
    } catch (err) {
        console.error("Error in deleting books:", err); // Log the detailed error
        res.status(500).json({ error: err.message });
    }
});

// Delete all books
app.delete('/api/books', async (req, res) => {
    try {
        await db.none('DELETE FROM books');
        await db.none('ALTER SEQUENCE books_id_seq RESTART WITH 1');
        res.status(200).json({ message: 'All books deleted successfully, and ID sequence reset' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Search books
app.get('/api/search', async (req, res) => {
    const { query, genre, author, minPrice, maxPrice } = req.query;

    // Start building the SQL query
    let sqlQuery = 'SELECT * FROM books WHERE 1=1';
    const params = [];

    // Add conditions based on the presence of query parameters
    if (query) {
        sqlQuery += ` AND (title ILIKE $1 OR author ILIKE $1 OR genre ILIKE $1)`;
        params.push(`%${query}%`);
    }

    if (genre) {
        sqlQuery += ` AND genre = $${params.length + 1}`;
        params.push(genre);
    }

    if (author) {
        sqlQuery += ` AND author ILIKE $${params.length + 1}`;
        params.push(`%${author}%`);
    }

    if (minPrice) {
        sqlQuery += ` AND price >= $${params.length + 1}`;
        params.push(parseFloat(minPrice));
    }

    if (maxPrice) {
        sqlQuery += ` AND price <= $${params.length + 1}`;
        params.push(parseFloat(maxPrice));
    }

    try {
        const books = await db.any(sqlQuery, params);
        res.json(books);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Advanced search
app.get('/api/advanced-search', async (req, res) => {
    const { title, author, genre, minPrice, maxPrice } = req.query;
    let query = 'SELECT * FROM books WHERE 1=1';
    const params = [];

    if (title) {
        query += ` AND title ILIKE $${params.length + 1}`;
        params.push(`%${title}%`);
    }

    if (author) {
        query += ` AND author ILIKE $${params.length + 1}`;
        params.push(`%${author}%`);
    }

    if (genre) {
        query += ` AND genre ILIKE $${params.length + 1}`;
        params.push(`%${genre}%`);
    }

    if (minPrice) {
        query += ` AND price >= $${params.length + 1}`;
        params.push(parseFloat(minPrice));
    }

    if (maxPrice) {
        query += ` AND price <= $${params.length + 1}`;
        params.push(parseFloat(maxPrice));
    }

    try {
        const books = await db.any(query, params);
        res.json(books);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Filter books by genre, author, and price range
app.get('/api/filter', async (req, res) => {
    const { genre, author, minPrice, maxPrice } = req.query;

    let sqlQuery = 'SELECT * FROM books WHERE 1=1';
    const params = [];

    if (genre) {
        sqlQuery += ` AND $1 = ANY(genre)`;
        params.push(genre);
    }

    if (author) {
        sqlQuery += ` AND $2 = ANY(author)`;
        params.push(author);
    }

    if (minPrice) {
        sqlQuery += ` AND price >= $${params.length + 1}`;
        params.push(parseFloat(minPrice));
    }

    if (maxPrice) {
        sqlQuery += ` AND price <= $${params.length + 1}`;
        params.push(parseFloat(maxPrice));
    }

    try {
        const books = await db.any(sqlQuery, params);
        const formattedBooks = books.map(book => ({
            id: book.id,
            isbn: book.isbn,
            title: book.title,
            author: book.author.join(', '),
            genre: book.genre.join(', '),
            price: parseFloat(book.price).toFixed(2),
            image_url: book.image_url,
            description: book.description
        }));
        res.json(formattedBooks);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
