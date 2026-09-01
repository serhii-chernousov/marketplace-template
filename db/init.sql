CREATE USER app_user WITH PASSWORD 'app-secret-initial';
GRANT ALL PRIVILEGES ON DATABASE shop TO app_user;
GRANT ALL ON SCHEMA public TO app_user;