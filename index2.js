const nodemailer = require('nodemailer');
const mysql = require('mysql2/promise'); // Usa mysql2/promise
const express = require('express');
const bp = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const moment = require('moment-timezone');
const QRCode = require('qrcode');

const SECRET_KEY = 'your_secret_key'; // Cambia esto por una clave secreta segura
const app = express();
app.use(bp.json());

const mysqlPool  = mysql.createPool({
    host: 'srv1059.hstgr.io',
    user: 'u729991132_root',
    password: 'Dragonb@ll2',
    database: 'u729991132_railway',
    port: 3306,
    waitForPools: true,
    PoolLimit: 50, // Ajusta según el rendimiento y necesidades
    queueLimit: 0
});


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const Pool = await mysqlPool.getPool();
        
        const [rows] = await Pool.query(
            "SELECT * FROM TBL_MS_USUARIO WHERE EMAIL = ?",
            [username]
        );
        Pool.release(); // Libera la conexión de la piscina

        if (rows.length === 0) {
            return res.status(404).send("Usuario no encontrado");
        }

        const user = rows[0];

        // Generar token al inicio
        const generateToken = () => {
            return jwt.sign({ id: user.ID_USUARIO }, SECRET_KEY, {
                expiresIn: 8400 // 90 minutos
            });
        };

        const token = generateToken();  // Generar el token

        if (user.ID_ESTADO_USUARIO === 5) {
            const Pool = await mysqlPool.getPool();
            const [adminRows] = await Pool.query(
                "SELECT EMAIL FROM TBL_MS_USUARIO WHERE ID_ROL = 1"
            );
            Pool.release(); // Libera la conexión de la piscina

            const adminEmails = adminRows.map(admin => admin.EMAIL);
            return res.status(402).json({
                message: "Comuníquese con los administradores para el uso de la aplicación",
                adminEmails: adminEmails,
                token: token  // Enviar token en la respuesta
            });
        } else if (user.ID_ESTADO_USUARIO === 2) {
            return res.status(403).send("Usuario inactivo");
        } else if (user.ID_ESTADO_USUARIO === 3) {
            return res.status(403).send("Usuario ha sido bloqueado");
        } else {
            const passwordIsValid = bcrypt.compareSync(password, user.CONTRASEÑA);

            if (!passwordIsValid) {
                const Pool = await mysqlPool.getPool();
                await Pool.query(
                    "UPDATE TBL_MS_USUARIO SET INTENTOS_FALLIDOS = INTENTOS_FALLIDOS + 1 WHERE EMAIL = ?",
                    [username]
                );

                const [paramRows] = await Pool.query(
                    "SELECT VALOR FROM TBL_MS_PARAMETROS WHERE ID_PARAMETRO = 1"
                );
                Pool.release(); // Libera la conexión de la piscina

                const maxLoginAttempts = parseInt(paramRows[0].VALOR, 10);
                if (user.INTENTOS_FALLIDOS + 1 >= maxLoginAttempts + 1) {
                    const Pool = await mysqlPool.getPool();
                    await Pool.query(
                        "UPDATE TBL_MS_USUARIO SET ID_ESTADO_USUARIO = 3 WHERE EMAIL = ?",
                        [username]
                    );
                    Pool.release(); // Libera la conexión de la piscina

                    return res.status(403).send("Usuario ha sido bloqueado por múltiples intentos fallidos");
                } else {
                    return res.status(401).send("Contraseña incorrecta");
                }
            } else {
                // Actualizar los campos INTENTOS_FALLIDOS y PRIMER_INGRESO después de verificar la contraseña
                const Pool = await mysqlPool.getPool();
                await Pool.query(
                    "UPDATE TBL_MS_USUARIO SET INTENTOS_FALLIDOS = 0, PRIMER_INGRESO = IF(PRIMER_INGRESO IS NULL, CONVERT_TZ(NOW(), @@session.time_zone, '-06:00'), PRIMER_INGRESO) WHERE EMAIL = ?",
                    [username]
                );

                if (user.ID_ESTADO_USUARIO === 1 && user.PRIMER_INGRESO_COMPLETADO === 0) {
                    // Redirigir al usuario a la página de completar información
                    res.status(200).json({ token, id_usuario: user.ID_USUARIO, redirect: '/completar_persona' });
                } else if (user.CODIGO_2FA === 1) {
                    // Generar y enviar código de verificación
                    const verificationCode = crypto.randomBytes(3).toString('hex').toUpperCase(); // Código de 6 dígitos en mayúsculas

                    await Pool.query(
                        "UPDATE TBL_MS_USUARIO SET CODIGO_VERIFICACION = ? WHERE EMAIL = ?",
                        [verificationCode, username]
                    );

                    const mailOptions = {
                        from: 'no-reply@yourdomain.com',
                        to: username,
                        subject: 'Código de Verificación 2FA',
                        text: `Tu código de verificación es: ${verificationCode}`
                    };

                    transporter.sendMail(mailOptions, (error, info) => {
                        if (error) {
                            console.log(error);
                            return res.status(500).send("Error al enviar el código de verificación");
                        }
                        // Enviar respuesta con el token y redirección para la verificación de código
                        res.status(200).json({ token, id_usuario: user.ID_USUARIO, redirect: '/validar_codigo_2fa' });
                    });
                } else {
                    // Si no se requiere 2FA, simplemente retorna el token y redirige
                    res.status(200).json({ token, id_usuario: user.ID_USUARIO, redirect: '/pantalla_principal' });
                }

                Pool.release(); // Libera la conexión de la piscina
            }
        }
    } catch (err) {
        console.error('Error en la operación de base de datos:', err);
        res.status(500).send("Error interno del servidor");
    }
});



function verifyToken(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) {
    return res.status(403).send("No token provided");
  }

  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) {
      return res.status(500).send("Failed to authenticate token");
    }

    req.userId = decoded.id;
    next();
  });
}


app.get('/protected', verifyToken, (req, res) => {
  res.status(200).send("Access granted");
});


//*************** Verificacion de 2FA *********
app.post('/validar_codigo_2fa', async (req, res) => {
  const { ID_USUARIO, CODIGO_VERIFICACION } = req.body;

  try {
    const Pool = await mysqlPool.getPool();
    
    const [results] = await Pool.query('SELECT * FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [ID_USUARIO]);
    Pool.release();

    if (results.length === 0) {
      return res.status(400).json({ message: 'Usuario no encontrado' });
    }

    const user = results[0];

    if (user.CODIGO_VERIFICACION !== CODIGO_VERIFICACION) {
      return res.status(400).json({ message: 'Código de verificación incorrecto' });
    }

    await Pool.query('UPDATE TBL_MS_USUARIO SET CODIGO_VERIFICACION = NULL WHERE ID_USUARIO = ?', [ID_USUARIO]);

    const generateToken = () => {
      return jwt.sign({ id: user.ID_USUARIO }, SECRET_KEY, {
        expiresIn: 5400 // 90 minutos
      });
    };

    const token = generateToken();  // Generar el token

    res.status(200).json({ token, id_usuario: user.ID_USUARIO, redirect: '/pantalla_principal' });
  } catch (err) {
    console.error('Error al verificar el código:', err);
    res.status(500).json({ message: 'Error al verificar el código' });
  }
});



//Actualizar el estado de 2FA
app.post('/set2FAStatus', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    console.error('Token no proporcionado');
    return res.status(401).json({ message: 'Token no proporcionado' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    const userId = decoded.id;

    const { enabled } = req.body;
    if (typeof enabled !== 'number' || (enabled !== 0 && enabled !== 1)) {
      return res.status(400).json({ message: 'Valor inválido para 2FA' });
    }

    const Pool = await mysqlPool.getPool();
    await Pool.query('UPDATE TBL_MS_USUARIO SET CODIGO_2FA = ? WHERE ID_USUARIO = ?', [enabled, userId]);
    Pool.release();

    res.json({ message: 'Estado de 2FA actualizado correctamente' });
  } catch (error) {
    console.error('Error al verificar el token:', error);
    res.status(500).json({ message: 'Error al verificar el token' });
  }
});


//********** GET CODIGO 2FA ********
app.get('/get2FAStatus', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    console.error('Token no proporcionado');
    return res.status(401).json({ message: 'Token no proporcionado' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    const userId = decoded.id;

    const Pool = await mysqlPool.getPool();
    const [results] = await Pool.query('SELECT CODIGO_2FA FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [userId]);
    Pool.release();

    if (results.length > 0) {
      res.json({ enabled: results[0].CODIGO_2FA });
    } else {
      res.status(404).json({ message: 'Usuario no encontrado' });
    }
  } catch (error) {
    console.error('Error al verificar el token:', error);
    res.status(500).json({ message: 'Error al verificar el token' });
  }
});






//********** REGISTRO *********** 

const secretKey = 'clave_secreta';

// SERVIDOR DE CORREO MAILTRAP
const transporter = nodemailer.createTransport({
    host: "sandbox.smtp.mailtrap.io",
    port: 2525,
    auth: {
      user: "a576baf13dcf6f",
      pass: "0243f06cea3940"
    }
});

app.post('/register', async (req, res) => {
  const { NOMBRE_USUARIO, EMAIL, CONTRASEÑA } = req.body;

  if (!NOMBRE_USUARIO || !EMAIL || !CONTRASEÑA) {
    return res.status(400).json({ message: 'Todos los campos son requeridos' });
  }

  try {
    const hashedPassword = await bcrypt.hash(CONTRASEÑA, 8);

    const Pool = await mysqlPool.getPool();
    
    const [results] = await Pool.query('SELECT * FROM TBL_MS_USUARIO WHERE EMAIL = ?', [EMAIL]);
    
    if (results.length > 0) {
      Pool.release();
      return res.status(400).json({ message: 'Correo ya registrado' });
    }

    const verificationCode = crypto.randomBytes(3).toString('hex').toUpperCase();
    const cipher = crypto.createCipher('aes-128-cbc', secretKey);
    let encryptedVerificationCode = cipher.update(verificationCode, 'utf8', 'hex');
    encryptedVerificationCode += cipher.final('hex');

    const query = 'INSERT INTO TBL_MS_USUARIO (NOMBRE_USUARIO, EMAIL, CONTRASEÑA, CODIGO_VERIFICACION, ID_ROL, ID_ESTADO_USUARIO, CODIGO_2FA) VALUES (?, ?, ?, ?, ?, ?, ?)';
    const [insertResults] = await Pool.query(query, [NOMBRE_USUARIO, EMAIL, hashedPassword, encryptedVerificationCode, 2, 5, 1]);

    const userId = insertResults.insertId; // Obtener el ID del usuario recién insertado

    // Insertar NOMBRE_USUARIO en la tabla TBL_PERSONAS
    const personaQuery = 'INSERT INTO TBL_PERSONAS (NOMBRE_PERSONA) VALUES (?)';
    await Pool.query(personaQuery, [NOMBRE_USUARIO]);

    Pool.release();

    // Enviar el correo de verificación
    const mailOptions = {
      from: 'no-reply@yourdomain.com',
      to: EMAIL,
      subject: 'Código de Verificación',
      text: `Tu código de verificación es: ${verificationCode}`
    };

    transporter.sendMail(mailOptions, (err, info) => {
      if (err) {
        console.error('Error al enviar el correo:', err);
        return res.status(500).json({ message: 'Error al enviar el correo de verificación' });
      }

      // Generar el token
      const token = jwt.sign({ id: userId }, SECRET_KEY, {
        expiresIn: 1800 // 30 minutos
      });

      res.status(201).json({
        token: token,
        id_usuario: userId,
        message: 'Usuario registrado exitosamente. Por favor verifica tu correo.'
      });
    });
  } catch (err) {
    console.error('Error al procesar el registro:', err);
    res.status(500).json({ message: 'Error al procesar el registro' });
  }
});



//******** Verificar registro ********
app.post('/verify', async (req, res) => {
  const { EMAIL, CODIGO_VERIFICACION } = req.body;

  try {
    const Pool = await mysqlPool.getPool();
    
    const [results] = await Pool.query('SELECT * FROM TBL_MS_USUARIO WHERE EMAIL = ?', [EMAIL]);
    
    if (results.length === 0) {
      Pool.release();
      return res.status(400).json({ message: 'Correo no encontrado' });
    }

    const user = results[0];

    if (user.INTENTOS_FALLIDOS >= 5) {
      await Pool.query('DELETE FROM TBL_MS_USUARIO WHERE EMAIL = ?', [EMAIL]);
      Pool.release();
      return res.status(400).json({ message: 'Has alcanzado el límite de intentos de verificación.' });
    }

    if (user.CODIGO_VERIFICACION === null) {
      Pool.release();
      return res.status(400).json({ message: 'No hay un código de verificación disponible para este usuario' });
    }

    const decipher = crypto.createDecipher('aes-128-cbc', secretKey);
    let decryptedVerificationCode;
    
    try {
      decryptedVerificationCode = decipher.update(user.CODIGO_VERIFICACION, 'hex', 'utf8');
      decryptedVerificationCode += decipher.final('utf8');
    } catch (error) {
      console.error('Error al descifrar el código:', error);
      Pool.release();
      return res.status(500).json({ message: 'Error al procesar el código de verificación' });
    }

    if (CODIGO_VERIFICACION !== decryptedVerificationCode) {
      await Pool.query('UPDATE TBL_MS_USUARIO SET INTENTOS_FALLIDOS = INTENTOS_FALLIDOS + 1 WHERE EMAIL = ?', [EMAIL]);
      Pool.release();
      return res.status(400).json({ message: 'Código de verificación incorrecto' });
    }

    const primerIngreso = moment().tz("America/Tegucigalpa").format('YYYY-MM-DD HH:mm:ss');

    const [parametroResults] = await Pool.query('SELECT VALOR FROM TBL_MS_PARAMETROS WHERE ID_PARAMETRO = 2');
    const diasVencimiento = parseInt(parametroResults[0].VALOR, 10);
    const fechaVencimiento = moment().add(diasVencimiento, 'days').format('YYYY-MM-DD');

    await Pool.query('UPDATE TBL_MS_USUARIO SET CODIGO_VERIFICACION = NULL, PRIMER_INGRESO = ?, FECHA_VENCIMIENTO = ?, ID_ESTADO_USUARIO = 5, INTENTOS_FALLIDOS = 0 WHERE EMAIL = ?', [primerIngreso, fechaVencimiento, EMAIL]);

    Pool.release();

    res.status(200).json({ message: 'Correo verificado exitosamente' });
  } catch (error) {
    console.error('Error al procesar la verificación:', error);
    res.status(500).json({ message: 'Error al procesar la verificación' });
  }
});



//*********** RESTABLECER CONTRASENA    *********** 
app.post('/restablecer_contrasena', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'El correo electrónico es requerido' });
  }

  try {
    const Pool = await mysqlPool.getPool();
    
    // Verificar si el usuario existe
    const [userResults] = await Pool.query('SELECT * FROM TBL_MS_USUARIO WHERE EMAIL = ?', [email]);
    
    if (userResults.length === 0) {
      Pool.release();
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const tempPassword = crypto.randomBytes(4).toString('hex');
    const hashedTempPassword = await bcrypt.hash(tempPassword, 10);

    // Eliminar cualquier entrada existente para el usuario en TBL_REINICIO_CONTRASEÑA
    await Pool.query('DELETE FROM TBL_REINICIO_CONTRASEÑA WHERE EMAIL = ?', [email]);

    // Insertar la nueva entrada en TBL_REINICIO_CONTRASEÑA
    await Pool.query('INSERT INTO TBL_REINICIO_CONTRASEÑA (TOKEN, EMAIL) VALUES (?, ?)', [hashedTempPassword, email]);

    Pool.release();

    const mailOptions = {
      from: 'no-reply@yourdomain.com',
      to: email,
      subject: 'Restablecer contraseña',
      text: `Esta es tu contraseña de verificación para poder restablecer la contraseña: ${tempPassword}`
    };

    transporter.sendMail(mailOptions, (error) => {
      if (error) {
        return res.status(500).json({ message: 'Error al enviar el correo' });
      }
      return res.status(200).json({ message: 'Correo enviado con éxito' });
    });
  } catch (error) {
    console.error('Error al procesar la solicitud de restablecimiento de contraseña:', error);
    res.status(500).json({ message: 'Error al procesar la solicitud de restablecimiento de contraseña' });
  }
});
  
  
app.post('/verificar_contrasena_temporal', async (req, res) => {
  const { email, tempPassword } = req.body;

  if (!email || !tempPassword) {
    return res.status(400).json({ message: 'El correo electrónico y la contraseña temporal son requeridos' });
  }

  try {
    const Pool = await mysqlPool.getPool();
    
    // Verificar el token
    const [tokenResults] = await Pool.query('SELECT * FROM TBL_REINICIO_CONTRASEÑA WHERE EMAIL = ?', [email]);

    if (tokenResults.length === 0) {
      Pool.release();
      return res.status(404).json({ message: 'Token no encontrado' });
    }

    const token = tokenResults[0];
    const isMatch = await bcrypt.compare(tempPassword, token.TOKEN);

    if (!isMatch) {
      Pool.release();
      return res.status(400).json({ message: 'Contraseña temporal incorrecta' });
    }

    // Obtener los datos del usuario
    const [userResults] = await Pool.query('SELECT ID_USUARIO, CONTRASEÑA FROM TBL_MS_USUARIO WHERE EMAIL = ?', [email]);

    if (userResults.length === 0) {
      Pool.release();
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const user = userResults[0];

    // Insertar en TBL_MS_HIST_CONTRASEÑA
    await Pool.query('INSERT INTO TBL_MS_HIST_CONTRASEÑA (ID_USUARIO, CONTRASEÑA) VALUES (?, ?)', [user.ID_USUARIO, user.CONTRASEÑA]);

    // Actualizar la contraseña, estado e intentos fallidos en TBL_MS_USUARIO
    const hashedTempPassword = await bcrypt.hash(tempPassword, 10);
    await Pool.query('UPDATE TBL_MS_USUARIO SET CONTRASEÑA = ?, ID_ESTADO_USUARIO = 1, INTENTOS_FALLIDOS = 0 WHERE ID_USUARIO = ?', [hashedTempPassword, user.ID_USUARIO]);

    Pool.release();

    // Generar el token
    token = jwt.sign({ id: user.ID_USUARIO }, SECRET_KEY, {
      expiresIn: 8400 // 90 minutos
    });

    res.status(200).json({ token, id_usuario: user.ID_USUARIO });
  } catch (error) {
    console.error('Error al procesar la verificación de la contraseña temporal:', error);
    res.status(500).json({ message: 'Error al procesar la verificación de la contraseña temporal' });
  }
});

  
  // ************  Ruta para actualizar la contraseña   **********
 app.post('/cambiar_contrasena', async (req, res) => {
  const { actual, nueva } = req.body;

  // Obtener el token del encabezado de autorización
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    console.error('Token no proporcionado');
    return res.status(401).json({ message: 'Token no proporcionado' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // Verificar y decodificar el token
    const decoded = jwt.verify(token, SECRET_KEY);
    const userId = decoded.id;

    const Pool = await mysqlPool.getPool();

    // Consultar la contraseña actual del usuario desde la base de datos
    const [userResults] = await Pool.query('SELECT CONTRASEÑA FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [userId]);

    if (userResults.length === 0) {
      Pool.release();
      console.error('Usuario no encontrado');
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const contrasenaActual = userResults[0].CONTRASEÑA;

    // Verificar si la nueva contraseña es igual a la actual
    const isSamePassword = await bcrypt.compare(nueva, contrasenaActual);
    if (isSamePassword) {
      Pool.release();
      console.error('No puedes reutilizar la contraseña actual');
      return res.status(400).json({ message: 'No puedes reutilizar la contraseña actual' });
    }

    // Verificar si la contraseña actual proporcionada es correcta
    const isMatch = await bcrypt.compare(actual, contrasenaActual);
    if (!isMatch) {
      Pool.release();
      console.error('Contraseña actual incorrecta');
      return res.status(401).json({ message: 'Contraseña actual incorrecta' });
    }

    // Hashear la nueva contraseña
    const nuevaHashed = await bcrypt.hash(nueva, 10);

    // Insertar la contraseña actual en la tabla TBL_MS_HIST_CONTRASEÑA
    await Pool.query('INSERT INTO TBL_MS_HIST_CONTRASEÑA (ID_USUARIO, CONTRASEÑA) VALUES (?, ?)', [userId, contrasenaActual]);

    // Actualizar la nueva contraseña en la tabla TBL_MS_USUARIO
    await Pool.query('UPDATE TBL_MS_USUARIO SET CONTRASEÑA = ? WHERE ID_USUARIO = ?', [nuevaHashed, userId]);

    Pool.release();

    res.status(200).json({ message: 'Contraseña actualizada correctamente' });
  } catch (error) {
    console.error('Error al cambiar la contraseña:', error);
    res.status(500).json({ message: 'Error al cambiar la contraseña' });
  }
});

  
  
  // ****** Ruta para cerrar sesión
app.post('/logout', verifyToken, (req, res) => {
  const token = req.headers['authorization'].split(' ')[1];

  // Aquí deberías agregar el token a una lista negra o a un almacenamiento para invalidarlo
  // Por ejemplo, puedes almacenar el token en una base de datos o en la memoria para su invalidación.

  // Ejemplo básico de invalidación de token
  // Suponiendo que tienes una función para almacenar tokens en una lista negra
  blacklistToken(token);

  return res.status(200).json({ message: 'Sesión cerrada exitosamente' });
});



// ************   Ruta para registrar una visita
app.post('/registrar_visitas', async (req, res) => {
  const { usuarioId, NOMBRE_VISITANTE, DNI_VISITANTE, NUM_PERSONAS, NUM_PLACA, isRecurrentVisitor, FECHA_VENCIMIENTO } = req.body;

  try {
    const Pool = await mysqlPool.getPool();

    // Obtener el NOMBRE_USUARIO usando el usuarioId
    const [usuarioResults] = await Pool.query('SELECT NOMBRE_USUARIO FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [usuarioId]);

    if (usuarioResults.length === 0) {
      Pool.release();
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const nombreUsuario = usuarioResults[0].NOMBRE_USUARIO;

    // Obtener el ID_PERSONA de la tabla TBL_PERSONAS usando el nombreUsuario
    const [personaResults] = await Pool.query('SELECT ID_PERSONA FROM TBL_PERSONAS WHERE NOMBRE_PERSONA = ?', [nombreUsuario]);

    if (personaResults.length === 0) {
      Pool.release();
      return res.status(404).json({ error: 'Persona no encontrada' });
    }

    const ID_PERSONA = personaResults[0].ID_PERSONA;

    // Obtener el valor del parámetro con ID_PARAMETRO = 3
    const [parametroResults] = await Pool.query('SELECT VALOR FROM TBL_MS_PARAMETROS WHERE ID_PARAMETRO = 3');

    if (parametroResults.length === 0) {
      Pool.release();
      return res.status(404).json({ message: 'Parámetro no encontrado' });
    }

    const horas = parametroResults[0].VALOR;
    const fechaActual = moment().tz('America/Tegucigalpa');
    const fechaCalculada = fechaActual.add(horas, 'hours').format('YYYY-MM-DD HH:mm:ss');
    const nuevaFechaActual = moment().tz('America/Tegucigalpa').format('YYYY-MM-DD HH:mm:ss'); // Create a new formatted date

    let insertQuery, insertParams;

    if (isRecurrentVisitor) {
      insertQuery = 'INSERT INTO TBL_VISITANTES_RECURRENTES (ID_PERSONA, NOMBRE_VISITANTE, DNI_VISITANTE, NUM_PERSONAS, NUM_PLACA, FECHA_HORA, FECHA_VENCIMIENTO) VALUES (?, ?, ?, ?, ?, ?, ?)';
      insertParams = [ID_PERSONA, NOMBRE_VISITANTE, DNI_VISITANTE, NUM_PERSONAS, NUM_PLACA, nuevaFechaActual, FECHA_VENCIMIENTO];
    } else {
      insertQuery = 'INSERT INTO TBL_REGVISITAS (ID_PERSONA, NOMBRE_VISITANTE, DNI_VISITANTE, NUM_PERSONAS, NUM_PLACA, FECHA_HORA) VALUES (?, ?, ?, ?, ?, ?)';
      insertParams = [ID_PERSONA, NOMBRE_VISITANTE, DNI_VISITANTE, NUM_PERSONAS, NUM_PLACA, fechaCalculada];
    }

    const [result] = await Pool.query(insertQuery, insertParams);

    // Insertar en la tabla TBL_BITACORA_VISITA
    const ID_VISITANTE = result.insertId; // Obtener el ID del visitante registrado

    let insertBitacoraQuery, insertBitacoraParams;

    if (isRecurrentVisitor) {
      insertBitacoraQuery = 'INSERT INTO TBL_BITACORA_VISITA (ID_PERSONA, ID_VISITANTE, NUM_PERSONA, NUM_PLACA, FECHA_HORA, FECHA_VENCIMIENTO) VALUES (?, ?, ?, ?, ?, ?)';
      insertBitacoraParams = [ID_PERSONA, ID_VISITANTE, NUM_PERSONAS, NUM_PLACA, fechaActual.format('YYYY-MM-DD HH:mm:ss'), FECHA_VENCIMIENTO];
    } else {
      insertBitacoraQuery = 'INSERT INTO TBL_BITACORA_VISITA (ID_PERSONA, ID_VISITANTE, NUM_PERSONA, NUM_PLACA, FECHA_HORA) VALUES (?, ?, ?, ?, ?)';
      insertBitacoraParams = [ID_PERSONA, ID_VISITANTE, NUM_PERSONAS, NUM_PLACA, fechaCalculada];
    }

    await Pool.query(insertBitacoraQuery, insertBitacoraParams);

    // Obtener la información adicional del QR
    const [personaInfoResults] = await Pool.query(`
      SELECT p.NOMBRE_PERSONA, p.DNI_PERSONA, c.DESCRIPCION AS CONTACTO, d.DESCRIPCION AS ID_CONDOMINIO
      FROM TBL_PERSONAS p
      LEFT JOIN TBL_CONTACTOS c ON p.ID_CONTACTO = c.ID_CONTACTO
      LEFT JOIN TBL_CONDOMINIOS d ON p.ID_CONDOMINIO = d.ID_CONDOMINIO
      WHERE p.ID_PERSONA = ?`, [ID_PERSONA]);

    if (personaInfoResults.length === 0) {
      Pool.release();
      return res.status(404).json({ message: 'Información del QR no encontrada' });
    }

    const personaInfo = personaInfoResults[0];
    let qrData;

    if (isRecurrentVisitor) {
      qrData = {
        Residente: personaInfo.NOMBRE_PERSONA,
        DNI_Residente: personaInfo.DNI_PERSONA,
        Contacto: personaInfo.CONTACTO,
        Condominio: personaInfo.ID_CONDOMINIO,
        NOMBRE_VISITANTE,
        DNI_VISITANTE,
        NUM_PERSONAS,
        NUM_PLACA,
        FECHA_VENCIMIENTO
      };
    } else {
      qrData = {
        Residente: personaInfo.NOMBRE_PERSONA,
        DNI_Residente: personaInfo.DNI_PERSONA,
        Contacto: personaInfo.CONTACTO,
        Condominio: personaInfo.ID_CONDOMINIO,
        NOMBRE_VISITANTE,
        DNI_VISITANTE,
        NUM_PERSONAS,
        NUM_PLACA,
        FECHA_HORA: fechaCalculada
      };
    }

    const qrUrl = await new Promise((resolve, reject) => {
      QRCode.toDataURL(JSON.stringify(qrData), (err, url) => {
        if (err) return reject(err);
        resolve(url);
      });
    });

    const insertQRQuery = 'INSERT INTO TBL_QR (ID_VISITANTE, QR_CODE, FECHA_VENCIMIENTO) VALUES (?, ?, ?)';
    await Pool.query(insertQRQuery, [ID_VISITANTE, qrUrl, isRecurrentVisitor ? FECHA_VENCIMIENTO : fechaCalculada]);

    Pool.release();

    res.status(201).json({
      message: isRecurrentVisitor ? 'Visitante recurrente registrado exitosamente' : 'Visita registrada exitosamente',
      qrCode: qrUrl
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Error en el servidor' });
  }
});





//validar QR

app.post('/validateQR', async (req, res) => {
  const { qrCode } = req.body;

  try {
    const Pool = await mysqlPool.getPool();

    // Consultar el código QR
    const [results] = await Pool.query('SELECT * FROM TBL_QR WHERE QR_CODE = ?', [qrCode]);

    if (results.length === 0) {
      Pool.release();
      return res.status(404).json({ message: 'Código QR no encontrado' });
    }

    const qrInfo = results[0];
    const fechaActual = moment().tz('America/Tegucigalpa').format('YYYY-MM-DD HH:mm:ss');

    if (fechaActual > qrInfo.FECHA_VENCIMIENTO) {
      Pool.release();
      return res.status(400).json({ message: 'Código QR expirado' });
    }

    Pool.release();
    res.status(200).json({ message: 'Código QR válido', qrInfo });
  } catch (error) {
    console.error('Error al validar el código QR:', error);
    res.status(500).json({ message: 'Error al validar el código QR' });
  }
});







// Crear un endpoint para obtener todos los anuncios
app.get('/anuncios_eventos', async (req, res) => {
  const usuarioId = req.query.usuario_id;

  const query = `
    SELECT ID_ANUNCIOS_EVENTOS, TITULO, DESCRIPCION, IMAGEN, FECHA_HORA 
    FROM TBL_ANUNCIOS_EVENTOS 
    WHERE ID_ESTADO_ANUNCIO_EVENTO = 1 
    AND ID_ANUNCIOS_EVENTOS NOT IN (
        SELECT ID_ANUNCIOS_EVENTOS FROM TBL_ANUNCIOS_OCULTOS WHERE ID_USUARIO = ?
    )
    ORDER BY FECHA_HORA DESC`;

  try {
    const Pool = await mysqlPool.getPool();
    const [results] = await Pool.query(query, [usuarioId]);
    Pool.release();
    res.status(200).json(results);
  } catch (error) {
    console.error('Error al obtener los anuncios:', error);
    res.status(500).send('Error al obtener los anuncios');
  }
});


// Endpoint para ocultar un anuncio
app.post('/ocultar_anuncio', async (req, res) => {
  const { usuarioId, anuncioId } = req.body;

  console.log('Datos recibidos:', req.body);

  const query = `
    INSERT INTO TBL_ANUNCIOS_OCULTOS (ID_USUARIO, ID_ANUNCIOS_EVENTOS) 
    VALUES (?, ?)`;

  try {
    const Pool = await mysqlPool.getPool();
    await Pool.query(query, [usuarioId, anuncioId]);
    Pool.release();
    res.status(200).send('Anuncio ocultado exitosamente');
  } catch (error) {
    console.error('Error al ocultar el anuncio:', error);
    res.status(500).send('Error al ocultar el anuncio');
  }
});


// Crear un endpoint para obtener los datos del perfil del usuario
app.get('/perfil', async (req, res) => {
  const usuarioId = req.query.usuario_id;

  const query = `
    SELECT NOMBRE_USUARIO, EMAIL, ID_ROL 
    FROM TBL_MS_USUARIO 
    WHERE ID_USUARIO = ?`;

  try {
    const Pool = await mysqlPool.getPool();
    const [results] = await Pool.query(query, [usuarioId]);
    Pool.release();

    if (results.length > 0) {
      res.status(200).json(results[0]);
    } else {
      console.log(`Usuario con ID ${usuarioId} no encontrado`);
      res.status(404).send('Usuario no encontrado');
    }
  } catch (error) {
    console.error('Error al obtener el perfil del usuario:', error);
    res.status(500).send('Error al obtener el perfil del usuario');
  }
});


//********** Consultar Reservaciones *********
app.get('/consultar_reservaciones', async (req, res) => {
  const usuarioId = req.query.usuario_id;

  try {
    const Pool = await mysqlPool.getPool();

    // Obtener el NOMBRE_USUARIO de la tabla TBL_MS_USUARIO usando usuarioId
    const [usuarioResults] = await Pool.query('SELECT NOMBRE_USUARIO FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [usuarioId]);

    if (!usuarioResults.length) {
      Pool.release();
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const nombreUsuario = usuarioResults[0].NOMBRE_USUARIO;

    // Obtener el ID_PERSONA de la tabla TBL_PERSONAS usando el nombreUsuario
    const [personaResults] = await Pool.query('SELECT ID_PERSONA FROM TBL_PERSONAS WHERE NOMBRE_PERSONA = ?', [nombreUsuario]);

    if (!personaResults.length) {
      Pool.release();
      return res.status(404).json({ error: 'Persona no encontrada' });
    }

    const ID_PERSONA = personaResults[0].ID_PERSONA;

    // Obtener todas las reservas para ese ID_PERSONA
    const query = `
      SELECT 
        p.NOMBRE_PERSONA, 
        i.NOMBRE_INSTALACION, 
        e.DESCRIPCION, 
        r.HORA_FECHA,
        r.TIPO_EVENTO
      FROM 
        TBL_RESERVAS r
      INNER JOIN 
        TBL_PERSONAS p ON r.ID_PERSONA = p.ID_PERSONA
      INNER JOIN 
        TBL_INSTALACIONES i ON r.ID_INSTALACION = i.ID_INSTALACION
      INNER JOIN 
        TBL_ESTADO_RESERVA e ON r.ID_ESTADO_RESERVA = e.ID_ESTADO_RESERVA
      WHERE 
        r.ID_PERSONA = ?
    `;

    const [reservasResults] = await Pool.query(query, [ID_PERSONA]);

    Pool.release();

    res.json(reservasResults);
  } catch (error) {
    console.error('Error al obtener las reservas:', error);
    res.status(500).json({ error: 'Error al obtener las reservas' });
  }
});


//********** Consultar Visitas *********
app.get('/consultar_visitas', async (req, res) => {
  const usuarioId = req.query.usuario_id;

  try {
    const Pool = await mysqlPool.getPool();

    // Obtener el NOMBRE_USUARIO de la tabla TBL_MS_USUARIO usando usuarioId
    const [usuarioResults] = await Pool.query('SELECT NOMBRE_USUARIO FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [usuarioId]);

    if (!usuarioResults.length) {
      Pool.release();
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const nombreUsuario = usuarioResults[0].NOMBRE_USUARIO;

    // Obtener el ID_PERSONA de la tabla TBL_PERSONAS usando el nombreUsuario
    const [personaResults] = await Pool.query('SELECT ID_PERSONA FROM TBL_PERSONAS WHERE NOMBRE_PERSONA = ?', [nombreUsuario]);

    if (!personaResults.length) {
      Pool.release();
      return res.status(404).json({ error: 'Persona no encontrada' });
    }

    const ID_PERSONA = personaResults[0].ID_PERSONA;

    // Consultar los registros de visitas en TBL_REGVISITAS
    const queryRegVisitas = `
      SELECT NOMBRE_VISITANTE, DNI_VISITANTE, NUM_PERSONAS, NUM_PLACA, FECHA_HORA, NULL AS FECHA_VENCIMIENTO, 'No recurrente' AS TIPO
      FROM TBL_REGVISITAS 
      WHERE ID_PERSONA = ?`;

    // Consultar los registros de visitas en TBL_VISITANTES_RECURRENTES
    const queryVisitantesRecurrentes = `
      SELECT NOMBRE_VISITANTE, DNI_VISITANTE, NUM_PERSONAS, NUM_PLACA, FECHA_HORA, FECHA_VENCIMIENTO, 'Recurrente' AS TIPO
      FROM TBL_VISITANTES_RECURRENTES 
      WHERE ID_PERSONA = ?`;

    const [regVisitasResults] = await Pool.query(queryRegVisitas, [ID_PERSONA]);
    const [visitantesRecurrentesResults] = await Pool.query(queryVisitantesRecurrentes, [ID_PERSONA]);

    // Combinar los resultados de ambas consultas
    const resultados = [...regVisitasResults, ...visitantesRecurrentesResults];

    Pool.release();

    // Retornar los resultados a la aplicación Flutter
    res.json(resultados);
  } catch (error) {
    console.error('Error al consultar visitas:', error);
    res.status(500).json({ error: 'Error al consultar visitas' });
  }
});



//********* Consultar familia ************
app.get('/consultar_familia', async (req, res) => {
  const usuarioId = req.query.usuario_id;

  try {
    const Pool = await mysqlPool.getPool();

    // Obtener el NOMBRE_USUARIO de la tabla TBL_MS_USUARIO usando usuarioId
    const [usuarioResults] = await Pool.query('SELECT NOMBRE_USUARIO FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [usuarioId]);

    if (!usuarioResults.length) {
      Pool.release();
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const nombreUsuario = usuarioResults[0].NOMBRE_USUARIO;

    // Obtener el ID_PERSONA y el ID_CONDOMINIO de la tabla TBL_PERSONAS usando el nombreUsuario
    const [personaResults] = await Pool.query('SELECT ID_PERSONA, ID_CONDOMINIO FROM TBL_PERSONAS WHERE NOMBRE_PERSONA = ?', [nombreUsuario]);

    if (!personaResults.length) {
      Pool.release();
      return res.status(404).json({ error: 'Persona no encontrada' });
    }

    const ID_PERSONA = personaResults[0].ID_PERSONA;
    const ID_CONDOMINIO = personaResults[0].ID_CONDOMINIO;

    // Consultar todas las personas con el mismo ID_CONDOMINIO
    const queryPersonas = `
      SELECT 
        p.NOMBRE_PERSONA, 
        p.DNI_PERSONA, 
        c.DESCRIPCION AS CONTACTO,
        tp.DESCRIPCION AS TIPO_PERSONA,
        ep.DESCRIPCION AS ESTADO_PERSONA,
        par.DESCRIPCION AS PARENTESCO,
        con.DESCRIPCION AS CONDOMINIO
      FROM TBL_PERSONAS p
      LEFT JOIN TBL_CONTACTOS c ON p.ID_CONTACTO = c.ID_CONTACTO
      LEFT JOIN TBL_TIPO_PERSONAS tp ON p.ID_TIPO_PERSONA = tp.ID_TIPO_PERSONA
      LEFT JOIN TBL_ESTADO_PERSONA ep ON p.ID_ESTADO_PERSONA = ep.ID_ESTADO_PERSONA
      LEFT JOIN TBL_PARENTESCOS par ON p.ID_PARENTESCO = par.ID_PARENTESCO
      LEFT JOIN TBL_CONDOMINIOS con ON p.ID_CONDOMINIO = con.ID_CONDOMINIO
      WHERE p.ID_CONDOMINIO = ?;
    `;

    const [personasResults] = await Pool.query(queryPersonas, [ID_CONDOMINIO]);

    Pool.release();

    // Retornar los resultados a la aplicación Flutter
    res.json(personasResults);
  } catch (error) {
    console.error('Error al consultar la familia:', error);
    res.status(500).json({ error: 'Error al consultar la familia' });
  }
});


//********** Insertar Reserva *****
app.post('/nueva_reserva', async (req, res) => {
  const { usuarioId, nombreInstalacion, tipoEvento, horaFecha } = req.body;

  console.log('Datos recibidos:', req.body);

  try {
    const Pool = await mysqlPool.getPool();

    // Obtener el NOMBRE_USUARIO usando el usuarioId
    const [usuarioResults] = await Pool.query('SELECT NOMBRE_USUARIO FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [usuarioId]);

    if (!usuarioResults.length) {
      Pool.release();
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const nombreUsuario = usuarioResults[0].NOMBRE_USUARIO;

    // Obtener el ID_PERSONA de la tabla TBL_PERSONAS usando el nombreUsuario
    const [personaResults] = await Pool.query('SELECT ID_PERSONA FROM TBL_PERSONAS WHERE NOMBRE_PERSONA = ?', [nombreUsuario]);

    if (!personaResults.length) {
      Pool.release();
      return res.status(404).json({ error: 'Persona no encontrada' });
    }

    const ID_PERSONA = personaResults[0].ID_PERSONA;

    // Buscar ID_INSTALACION por nombre
    const [instalacionResults] = await Pool.query('SELECT ID_INSTALACION FROM TBL_INSTALACIONES WHERE NOMBRE_INSTALACION = ?', [nombreInstalacion]);

    if (!instalacionResults.length) {
      Pool.release();
      return res.status(404).json({ error: 'Instalación no encontrada' });
    }

    const ID_INSTALACION = instalacionResults[0].ID_INSTALACION;

    // Verificar si ya existe una reserva para esa fecha y hora en la misma instalación
    const [reservaResults] = await Pool.query('SELECT * FROM TBL_RESERVAS WHERE ID_INSTALACION = ? AND HORA_FECHA = ?', [ID_INSTALACION, horaFecha]);

    if (reservaResults.length > 0) {
      Pool.release();
      return res.status(400).json({ error: 'Horario ya reservado' });
    }

    // Insertar la reserva si no hay conflicto
    const [insertResult] = await Pool.query(
      'INSERT INTO TBL_RESERVAS (ID_PERSONA, ID_INSTALACION, ID_ESTADO_RESERVA, TIPO_EVENTO, HORA_FECHA) VALUES (?, ?, 3, ?, ?)',
      [ID_PERSONA, ID_INSTALACION, tipoEvento, horaFecha]
    );

    Pool.release();
    res.status(201).json({ message: 'Reserva creada exitosamente', reservaId: insertResult.insertId });
  } catch (error) {
    console.error('Error al crear la reserva:', error);
    res.status(500).json({ error: 'Error al crear la reserva' });
  }
});



// ******* Tipos de Instalaciones *******
app.get('/instalaciones', async (req, res) => {
  try {
    const Pool = await mysqlPool.getPool();
    const [results] = await Pool.query('SELECT NOMBRE_INSTALACION FROM TBL_INSTALACIONES');
    Pool.release();
    res.json(results);
  } catch (err) {
    console.error('Error al ejecutar la consulta:', err);
    res.status(500).json({ error: 'Error al ejecutar la consulta' });
  }
});



//Actualizar el estado de 2FA
app.post('/set2FAStatus', async (req, res) => {
  // Obtener el token del encabezado de autorización
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    console.error('Token no proporcionado');
    return res.status(401).json({ message: 'Token no proporcionado' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // Verificar y decodificar el token
    const decoded = jwt.verify(token, SECRET_KEY);
    const userId = decoded.id;

    const { enabled } = req.body;
    if (typeof enabled !== 'number' || (enabled !== 0 && enabled !== 1)) {
      return res.status(400).json({ message: 'Valor inválido para 2FA' });
    }

    // Actualizar el estado de 2FA en la base de datos
    const Pool = await mysqlPool.getPool();
    await Pool.query('UPDATE TBL_MS_USUARIO SET CODIGO_2FA = ? WHERE ID_USUARIO = ?', [enabled, userId]);
    Pool.release();

    res.json({ message: 'Estado de 2FA actualizado correctamente' });
  } catch (error) {
    console.error('Error al verificar el token o actualizar el estado de 2FA:', error);
    res.status(500).json({ message: 'Error interno del servidor' });
  }
});


//************** PERSONAS *************
app.get('/personas', async (req, res) => {
  try {
    const Pool = await mysqlPool.getPool();
    const [results] = await Pool.query('SELECT DESCRIPCION FROM TBL_ESTADO_PERSONA');
    Pool.release();
    res.json(results);
  } catch (err) {
    console.error('Error al ejecutar la consulta:', err);
    res.status(500).json({ error: 'Error al ejecutar la consulta' });
  }
});

app.get('/contacto', async (req, res) => {
  try {
    const Pool = await mysqlPool.getPool();
    const [results] = await Pool.query('SELECT DESCRIPCION FROM TBL_TIPO_CONTACTO');
    Pool.release();
    res.json(results);
  } catch (err) {
    console.error('Error al ejecutar la consulta:', err);
    res.status(500).json({ error: 'Error al ejecutar la consulta' });
  }
});


app.get('/parentesco', async (req, res) => {
  try {
    const Pool = await mysqlPool.getPool();
    const [results] = await Pool.query('SELECT DESCRIPCION FROM TBL_PARENTESCOS');
    Pool.release();
    res.json(results);
  } catch (err) {
    console.error('Error al ejecutar la consulta:', err);
    res.status(500).json({ error: 'Error al ejecutar la consulta' });
  }
});


//********* NUEVA PERSONA*********
app.post('/nueva_persona', async (req, res) => {
  const { usuarioId, P_DNI, P_TIPO_CONTACTO, P_CONTACTO, P_PARENTESCO, P_CONDOMINIO } = req.body;

  console.log('Datos recibidos:', req.body);

  try {
    // Obtener el NOMBRE_USUARIO de la tabla TBL_MS_USUARIO usando usuarioId
    const [usuarioResults] = await mysqlPool.query('SELECT NOMBRE_USUARIO FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [usuarioId]);
    
    if (!usuarioResults.length) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const nombreUsuario = usuarioResults[0].NOMBRE_USUARIO;

    // Obtener el ID_PERSONA de la tabla TBL_PERSONAS usando el nombreUsuario
    const [personaResults] = await mysqlPool.query('SELECT ID_PERSONA FROM TBL_PERSONAS WHERE NOMBRE_PERSONA = ?', [nombreUsuario]);

    if (!personaResults.length) {
      return res.status(404).json({ error: 'Persona no encontrada' });
    }

    const ID_PERSONA = personaResults[0].ID_PERSONA;

    // Verificación si el condominio existe
    const [condominioResults] = await mysqlPool.query('SELECT ID_CONDOMINIO FROM TBL_CONDOMINIOS WHERE DESCRIPCION = ?', [P_CONDOMINIO]);

    if (!condominioResults.length) {
      return res.status(404).json({ error: 'Condominio no encontrado' });
    }

    const ID_CONDOMINIO = condominioResults[0].ID_CONDOMINIO;

    // Verificar si hay un administrador (ID_PADRE = 1) para este condominio
    const [adminResults] = await mysqlPool.query('SELECT COUNT(*) AS adminCount FROM TBL_PERSONAS WHERE ID_CONDOMINIO = ? AND ID_PADRE = 1', [ID_CONDOMINIO]);

    const adminCount = adminResults[0].adminCount;
    const isAdminRequired = adminCount === 0; // Si no hay administrador, se debe insertar 1 en ID_PADRE

    // Consultar los IDs necesarios
    const [tipoContactoResults] = await mysqlPool.query('SELECT ID_TIPO_CONTACTO FROM TBL_TIPO_CONTACTO WHERE DESCRIPCION = ?', [P_TIPO_CONTACTO]);
    const [parentescoResults] = await mysqlPool.query('SELECT ID_PARENTESCO FROM TBL_PARENTESCOS WHERE DESCRIPCION = ?', [P_PARENTESCO]);

    if (!tipoContactoResults.length || !parentescoResults.length) {
      return res.status(405).json({ error: 'Datos no encontrados' });
    }

    const ID_TIPO_CONTACTO = tipoContactoResults[0].ID_TIPO_CONTACTO;
    const ID_PARENTESCO = parentescoResults[0].ID_PARENTESCO;

    // Insertar contacto
    const [contactoResults] = await mysqlPool.query('INSERT INTO TBL_CONTACTOS (ID_TIPO_CONTACTO, DESCRIPCION) VALUES (?, ?)', [ID_TIPO_CONTACTO, P_CONTACTO]);
    const ID_CONTACTO = contactoResults.insertId;

    // Construir consulta de actualización de persona
    const updatePersonaQuery = isAdminRequired
      ? 'UPDATE TBL_PERSONAS SET DNI_PERSONA = ?, ID_CONTACTO = ?, ID_ESTADO_PERSONA = ?, ID_PARENTESCO = ?, ID_CONDOMINIO = ?, ID_PADRE = 1 WHERE ID_PERSONA = ?'
      : 'UPDATE TBL_PERSONAS SET DNI_PERSONA = ?, ID_CONTACTO = ?, ID_ESTADO_PERSONA = ?, ID_PARENTESCO = ?, ID_CONDOMINIO = ?, ID_PADRE = NULL WHERE ID_PERSONA = ?';

    const queryParams = [P_DNI, ID_CONTACTO, 1, ID_PARENTESCO, ID_CONDOMINIO, ID_PERSONA];
    
    await mysqlPool.query(updatePersonaQuery, queryParams);

    // Enviar correo si es el primer administrador
    if (isAdminRequired) {
      const [adminEmails] = await mysqlPool.query('SELECT EMAIL FROM TBL_MS_USUARIO WHERE ID_ROL = 1');
      const emailList = adminEmails.map(row => row.EMAIL);
      
      const mailOptions = {
        from: 'tuemail@dominio.com',
        to: emailList,
        subject: 'Nuevo Administrador de Condominio',
        text: `Se ha registrado un nuevo administrador para el condominio:\n\nNombre: ${nombreUsuario}\nContacto: ${P_CONTACTO}\nCondominio: ${P_CONDOMINIO}`
      };

      await transporter.sendMail(mailOptions);
      console.log('Correo enviado a:', emailList);
    }

    res.status(201).json({ success: true, message: 'Persona actualizada correctamente' });

  } catch (err) {
    console.error('Error en la operación:', err);
    res.status(500).json({ error: 'Error en la operación' });
  }
});




//********** Actualizar lo PRIMER_INGRESO_COMPLETADO ********
app.put('/desactivarPersona', async (req, res) => {
  const { ID_USUARIO } = req.body;

  if (!ID_USUARIO) {
    return res.status(400).json({ error: 'ID_USUARIO es requerido' });
  }

  const updateQuery = 'UPDATE TBL_MS_USUARIO SET PRIMER_INGRESO_COMPLETADO = 1 WHERE ID_USUARIO = ?';

  try {
    const Pool = await mysqlPool.getPool();
    const [result] = await Pool.query(updateQuery, [ID_USUARIO]);

    Pool.release();

    if (result.affectedRows > 0) {
      res.status(200).json({ success: true, message: 'PRIMER_INGRESO_COMPLETADO actualizado correctamente' });
    } else {
      res.status(404).json({ error: 'No se encontró el usuario con el ID_USUARIO proporcionado' });
    }
  } catch (err) {
    console.error('Error al actualizar PRIMER_INGRESO_COMPLETADO:', err);
    res.status(500).json({ error: 'Error al actualizar PRIMER_INGRESO_COMPLETADO' });
  }
});
