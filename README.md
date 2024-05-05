## SBM Electic Consume Meter

### Application with a NodeJS backend and a MySQL database

Project structure:
```
.
├── backend
│   ├── Dockerfile
│   ...
├── db
│   └── password.txt
├── compose.yaml
└── README.md
```

[_compose.yaml_](compose.yaml)
```
services:
  backend:
    build: backend
    ports:
      - 80:80
      - 9229:9229
      - 9230:9230
    ...
  db:
    # We use a mariadb image which supports both amd64 & arm64 architecture
    image: mariadb:10.6.4-focal
    # If you really want to use MySQL, uncomment the following line
    #image: mysql:8.0.27
```
The compose file defines an application with three services `backend` and `db`.

> ℹ️ **_INFO_**  
> For compatibility purpose between `AMD64` and `ARM64` architecture, we use a MariaDB as database instead of MySQL.  
> You still can use the MySQL image by uncommenting the following line in the Compose file   
> `#image: mysql:8.0.27`

## Deploy with docker compose

```
$ docker compose up -d
```

## Expected result

Listing containers must show containers running and the port mapping as below:
```
$ docker ps
CONTAINER ID        IMAGE                          COMMAND                  CREATED             STATUS                   PORTS                                                  NAMES
9422da53da76        express-mysql_backend    "docker-entrypoint.s…"   8 minutes ago       Up 8 minutes (healthy)   0.0.0.0:80->80/tcp, 0.0.0.0:9229-9230->9229-9230/tcp   express-mysql_backend_1
a434bce6d2be        mysql:8.0.19                   "docker-entrypoint.s…"   8 minutes ago       Up 8 minutes             3306/tcp, 33060/tcp                                    express-mysql_db_1
```

The backend service container has the port 80 mapped to 80 on the host.
```
$ curl localhost:80
{"message":"Hello from MySQL 8.0.19"}
```

Stop and remove the containers
```
$ docker compose down
Stopping express-mysql_backend_1  ... done
Stopping express-mysql_db_1       ... done
Removing express-mysql_backend_1  ... done
Removing express-mysql_db_1       ... done
Removing network express-mysql_default

```

## Database handle

We are handle the database with https://knexjs.org

Migration structure:
```
.
├── backend
│   ├── migrations
│   │     └── 20240502013643_v1.js
│   ├── knexfile.js
│   ...
```
It is using the config.js to connect to the database too.

### Running Migrations

```
$ docker images
----> Here take the IMAGE_ID
$ docker exec -it {IMAGE_ID} bash -c "knex migrate:latest"
```

### Expected result
```
Using environment: development
Batch 1 run: 1 migrations
```
If the migrations is already runned
```
Using environment: development
Already up to date
```

### Running Seeds
```
$ docker images
----> Here take the IMAGE_ID
$ docker exec -it {IMAGE_ID} bash -c "knex seed:run"
```