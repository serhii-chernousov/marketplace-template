import 'reflect-metadata'
import { DataSource } from 'typeorm'

/**
 * CLI DataSource for migrations, seed, demos and reports.
 * Reads DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME from process.env
 * (Infisical wrapper or SKIP_VAULT=1). pg uses `user`; TypeORM uses `username`.
 */
export default new DataSource({
	type: 'postgres',
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	username: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
	synchronize: false,
	logging: false,
	entities: [__dirname + '/../entities/*.js'],
	migrations: [__dirname + '/../migrations/*.js'],
})
