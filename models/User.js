import { pool } from '../config/database.js';
import bcrypt from 'bcrypt';

class User {
  static async findByEmail(email) {
    try {
      const query = 'SELECT * FROM users WHERE email = $1 AND is_active = true';
      const result = await pool.query(query, [email]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error finding user by email:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      const query = 'SELECT id, email, role, first_name, last_name, is_active, created_at FROM users WHERE id = $1 AND is_active = true';
      const result = await pool.query(query, [id]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error finding user by ID:', error);
      throw error;
    }
  }

  static async create({ email, password, role, firstName, lastName }) {
    try {
      const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      
      const query = `
        INSERT INTO users (email, password_hash, role, first_name, last_name)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, email, role, first_name, last_name, created_at
      `;
      
      const result = await pool.query(query, [email, passwordHash, role, firstName, lastName]);
      return result.rows[0];
    } catch (error) {
      if (error.code === '23505') { // Unique violation
        throw new Error('User with this email already exists');
      }
      console.error('Error creating user:', error);
      throw error;
    }
  }

  static async validatePassword(plainPassword, hashedPassword) {
    try {
      return await bcrypt.compare(plainPassword, hashedPassword);
    } catch (error) {
      console.error('Error validating password:', error);
      throw error;
    }
  }

  static async updateLastLogin(userId) {
    try {
      const query = 'UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1';
      await pool.query(query, [userId]);
    } catch (error) {
      console.error('Error updating last login:', error);
      throw error;
    }
  }

  static async getAllUsers() {
    try {
      const query = `
        SELECT id, email, role, first_name, last_name, is_active, created_at, updated_at
        FROM users
        ORDER BY created_at DESC
      `;
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      console.error('Error getting all users:', error);
      throw error;
    }
  }

  static async updateUserStatus(userId, isActive) {
    try {
      const query = 'UPDATE users SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2';
      await pool.query(query, [isActive, userId]);
    } catch (error) {
      console.error('Error updating user status:', error);
      throw error;
    }
  }

  static async changePassword(userId, newPassword) {
    try {
      const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
      const passwordHash = await bcrypt.hash(newPassword, saltRounds);
      
      const query = 'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2';
      await pool.query(query, [passwordHash, userId]);
    } catch (error) {
      console.error('Error changing password:', error);
      throw error;
    }
  }

  static async updateUser(userId, { email, role, firstName, lastName }) {
    try {
      let query = 'UPDATE users SET updated_at = CURRENT_TIMESTAMP';
      let params = [];
      let paramIndex = 1;
      
      if (email) {
        query += `, email = $${paramIndex}`;
        params.push(email);
        paramIndex++;
      }
      
      if (role) {
        query += `, role = $${paramIndex}`;
        params.push(role);
        paramIndex++;
      }
      
      if (firstName) {
        query += `, first_name = $${paramIndex}`;
        params.push(firstName);
        paramIndex++;
      }
      
      if (lastName) {
        query += `, last_name = $${paramIndex}`;
        params.push(lastName);
        paramIndex++;
      }
      
      query += ` WHERE id = $${paramIndex} RETURNING id, email, role, first_name, last_name, is_active, created_at, updated_at`;
      params.push(userId);
      
      const result = await pool.query(query, params);
      return result.rows[0];
    } catch (error) {
      if (error.code === '23505') { // Unique violation
        throw new Error('User with this email already exists');
      }
      console.error('Error updating user:', error);
      throw error;
    }
  }

  static async deleteUser(userId) {
    try {
      const query = 'DELETE FROM users WHERE id = $1 RETURNING id';
      const result = await pool.query(query, [userId]);
      return result.rows[0];
    } catch (error) {
      console.error('Error deleting user:', error);
      throw error;
    }
  }
}

export default User;