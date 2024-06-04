const { body, param, query } = require('express-validator');

// Login Validation
const validateLogin = [
    body('username').notEmpty().withMessage('username parameter is required').isString().withMessage('username parameter must be a string'),
    body('password').notEmpty().withMessage('Password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]+$/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character')
];
// User Validation
const validateCreateUser = [
    body('username').notEmpty().withMessage('username parameter is required').isString().withMessage('username parameter must be a string'),
    body('password').notEmpty().withMessage('Password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]+$/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'),
    body('role').notEmpty().withMessage('Role parameter missing')
    .isString().withMessage('Role parameter must be a string')
    .matches(/^(OPERADOR|FACTURADOR|ADMINISTRADOR)$/).withMessage('Role must be either OPERADOR, FACTURADOR or ADMINISTRADOR')
  ];

  const validateUpdateUser = [
    param('id').notEmpty().withMessage('ID path parameter is required').isInt().withMessage('ID path parameter must be a number'),
    body('username').notEmpty().withMessage('username parameter is required').isString().withMessage('username parameter must be a string'),
    body('password').notEmpty().withMessage('Password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]+$/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'),
    body('role').notEmpty().withMessage('Role parameter missing')
    .isString().withMessage('Role parameter must be a string')
    .matches(/^(OPERADOR|FACTURADOR|ADMINISTRADOR)$/).withMessage('Role must be either \'OPERADOR\', \'FACTURADOR\' or \'ADMINISTRADOR\'')
  ];

  const validateId = [
    param('id').notEmpty().withMessage('ID path parameter is required').isInt().withMessage('ID path parameter must be a number')
  ];

  const validateDate = [
    query('from').isString().withMessage('from path parameter must be a string').notEmpty().withMessage('from query parameter is required'),
    query('to').isString().withMessage('to path parameter must be a string').notEmpty().withMessage('to query parameter is required')
  ];


// Measurer Validation
const validateCreateMeasurer = [
    body('pedestal').notEmpty().withMessage('pedestal parameter is required').isString().withMessage('pedestal parameter must be a string'),
    body('pedestal_id').notEmpty().withMessage('pedestal_id parameter is required').isString().withMessage('pedestal_id parameter must be a string'),
    body('measurer_code').notEmpty().withMessage('measurer_code parameter is required').isString().withMessage('measurer_code parameter must be a string')
];

const validateUpdateMeasurer = [
    param('id').notEmpty().withMessage('ID path parameter is required').isInt().withMessage('ID path parameter must be a number'),
    body('pedestal').notEmpty().withMessage('pedestal parameter is required').isString().withMessage('pedestal parameter must be a string'),
    body('pedestal_id').notEmpty().withMessage('pedestal_id parameter is required').isString().withMessage('pedestal_id parameter must be a string'),
    body('measurer_code').notEmpty().withMessage('measurer_code parameter is required').isString().withMessage('measurer_code parameter must be a string')
];


// Invoice Validation
const validateCreateInvoice = [
  body('sbmqb_customer_name').notEmpty().withMessage('sbmqb_customer_name parameter is required').isString().withMessage('sbmqb_customer_name parameter must be a string'),
  body('sbmqb_service').notEmpty().withMessage('sbmqb_service parameter is required').isString().withMessage('sbmqb_service parameter must be a string'),
  body('measurer_code').notEmpty().withMessage('measurer_code parameter is required').isString().withMessage('measurer_code parameter must be a string'),
  body('initial_measure_value').notEmpty().withMessage('initial_measure_value parameter is required').isDecimal().withMessage('initial_measure_value parameter must be a decimal'),
  body('current_measure_value').notEmpty().withMessage('current_measure_value parameter is required').isDecimal().withMessage('current_measure_value parameter must be a decimal'),
  body('total_measure_value').notEmpty().withMessage('total_measure_value parameter is required').isDecimal().withMessage('total_measure_value parameter must be a decimal'),
  body('begin_date').notEmpty().withMessage('begin_date parameter is required').isString().withMessage('begin_date parameter must be a string on this format: \'1999-12-30 01:55:56.416\''),
  body('end_date').notEmpty().withMessage('end_date parameter is required').isString().withMessage('end_date parameter must be a string on this format: \'1999-12-30 01:55:56.416\''),
  body('status').notEmpty().withMessage('status parameter missing')
  .isString().withMessage('status parameter must be a string')
  .matches(/^(PENDIENTE|PROCESANDO|FACTURADO)$/).withMessage('status must be either \'PENDIENTE\', \'PROCESANDO\' or \'FACTURADO\''),
  body('sbmqb_invoice_id').notEmpty().withMessage('sbmqb_invoice_id parameter is required').isString().withMessage('sbmqb_invoice_id parameter must be a string'),
];
// Measurement Validation
const validateCreateMeasurements = [
    //body('user_id').notEmpty().withMessage('user_id parameter is required').isInt().withMessage('user_id parameter must be a number'),
    body('measurer_id').notEmpty().withMessage('measurer_id parameter is required').isInt().withMessage('measurer_id parameter must be a number'),
    body('sbmqb_customer_name').notEmpty().withMessage('sbmqb_customer_name parameter is required').isString().withMessage('sbmqb_customer_name parameter must be a string'),
    //body('sbmqb_customer_id').notEmpty().withMessage('sbmqb_customer_id parameter is required').isInt().withMessage('sbmqb_customer_id parameter must be a number'),
    //body('last_measure_value').notEmpty().withMessage('last_measure_value parameter is required').isDecimal().withMessage('last_measure_value parameter must be a decimal'),
    //body('last_measure_date').notEmpty().withMessage('last_measure_date parameter is required').isString().withMessage('last_measure_date parameter must be a string on this format: \'1999-12-30 01:55:56.416\''),
    body('current_measure_value').notEmpty().withMessage('current_measure_value parameter is required').isDecimal().withMessage('current_measure_value parameter must be a decimal'),
    body('current_measure_date').notEmpty().withMessage('current_measure_date parameter is required').isString().withMessage('current_measure_date parameter must be a string on this format: \'1999-12-30 01:55:56.416\''),
    body('status').notEmpty().withMessage('status parameter missing')
    .isString().withMessage('status parameter must be a string')
    .matches(/^(PENDIENTE|PROCESANDO|FACTURADO)$/).withMessage('status must be either \'PENDIENTE\', \'PROCESANDO\' or \'FACTURADO\'')
];

const validateUpdateMeasurements = [
    param('id').notEmpty().withMessage('ID path parameter is required').isInt().withMessage('ID path parameter must be a number'),
    //body('measurer_id').notEmpty().withMessage('measurer_id parameter is required').isInt().withMessage('measurer_id parameter must be a number'),
    //body('sbmqb_customer_name').notEmpty().withMessage('sbmqb_customer_name parameter is required').isString().withMessage('sbmqb_customer_name parameter must be a string'),
    //body('current_measure_value').notEmpty().withMessage('current_measure_value parameter is required').isDecimal().withMessage('current_measure_value parameter must be a decimal'),
    //body('current_measure_date').notEmpty().withMessage('current_measure_date parameter is required').isString().withMessage('current_measure_date parameter must be a string on this format: \'1999-12-30 01:55:56.416\''),
    body('status').notEmpty().withMessage('status parameter missing')
    .isString().withMessage('status parameter must be a string')
    .matches(/^(PENDIENTE|PROCESANDO|FACTURADO)$/).withMessage('status must be either \'PENDIENTE\', \'PROCESANDO\' or \'FACTURADO\'')
];


const validateUpdateInvoice = [
  param('id').notEmpty().withMessage('ID path parameter is required').isInt().withMessage('ID path parameter must be a number'),
  //body('measurer_id').notEmpty().withMessage('measurer_id parameter is required').isInt().withMessage('measurer_id parameter must be a number'),
  //body('sbmqb_customer_name').notEmpty().withMessage('sbmqb_customer_name parameter is required').isString().withMessage('sbmqb_customer_name parameter must be a string'),
  //body('current_measure_value').notEmpty().withMessage('current_measure_value parameter is required').isDecimal().withMessage('current_measure_value parameter must be a decimal'),
  //body('current_measure_date').notEmpty().withMessage('current_measure_date parameter is required').isString().withMessage('current_measure_date parameter must be a string on this format: \'1999-12-30 01:55:56.416\''),
  body('status').notEmpty().withMessage('status parameter missing')
  .isString().withMessage('status parameter must be a string')
  .matches(/^(PENDIENTE|PROCESANDO|FACTURADO)$/).withMessage('status must be either \'PENDIENTE\', \'PROCESANDO\' or \'FACTURADO\'')
];


  module.exports = {
    validateCreateUser,
    validateUpdateUser,
    validateId,
    validateDate,
    validateLogin,
    validateCreateMeasurer,
    validateUpdateMeasurer,
    validateCreateMeasurements,
    validateUpdateMeasurements,
    validateCreateInvoice,
    validateUpdateInvoice
  }