/**
 * It contains functions related with authentication.
 */

const AWS = require('aws-sdk')
const User = require('../models/user')
const jwt = require('jsonwebtoken')
const shortId = require('shortid')
const expressJwt = require('express-jwt')
const lodash = require('lodash');

const {emailVerificationParams, emailForgetPasswordParams} = require('../utils/email')
const {listEnum} = require('../listEnum')

require('dotenv').config();

/**
 * AWS SNS configuration as email service provider
 */

AWS.config.update({
    accessKeyId: process.env.AWS_APP_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
    region: process.env.AWS_REGION
});

const ses = new AWS.SES({
    apiVersion: '2010-12-01',
});

/**
 * register : function to register user and then create email authentication 
 * @param {json} req : request object.
 * @param {json} res : response object.
 * @return {json} JSON message success or error
 */
exports.register = (req, res) => {
    const{name, email, password} = req.body;

    //check if user exists in our db
    User.findOne({email}).exec((err, user) => {

        //if exists, return error
        if (user) { 
            return res.status(400).json({
                error: 'Email is taken'
            });
        }

        //if not exits, generate token with user name, email and password
        const token = jwt.sign({name, email, password}, process.env.JWT_ACCOUNT_ACTIVATION, {
            expiresIn: process.env.JWT_EXPIRED
        });

        //create params for email verification
        const emailVerificationParam = emailVerificationParams(email, token)
        const sendEmailOnRegister = ses.sendEmail(emailVerificationParam).promise();

        //send email
        sendEmailOnRegister
        .then( data => {
            console.log('Email is submitted: ', data)
            res.json({ message: `Email has been sent to ${email}. Follow the instructions to complete your registration`  });
        })
        .catch( error => {
            console.log('Submit email error: ', error)
            res.status(422).json({ error: `We could not verify your email ${email}. Please try again` });
        })
    }) 
};

/**
 * registerActivate : function to activate the email that has been registered 
 * @param {json} req : request object.
 * @param {json} res : response object.
 * @return {json} JSON message success or error
 */
exports.registerActivate = (req, res) => {
    const {token} = req.body;
  
    //verify token.
    jwt.verify(token, process.env.JWT_ACCOUNT_ACTIVATION, (error, decodedMsg) => {
        console.log(error)
        if(error) {
            return res.status(process.env.APPLICATION_ERROR_CODE).json({
                error: 'Expired link. Try again'
            })
        }
        
        //get name, email and password from token.
        const {name, email, password} = jwt.decode(token)

        //generate username
        const username = shortId.generate();

        //check if user with that email is existed
        User.findOne({email}).exec((err, user) => {

            //return error if user is exists
            if(user) {
                return res.status(401).json({
                    error: 'Email is already taken'
                })
            }

            //create new user
            const newUser = new User({ username, name, email, password })
            newUser.save((err, result) => {
                if(err) {
                    return res.status(401).json({
                        error: 'Unable to save your data. Try again.'
                    })
                }

                //save successfully
                return res.json({
                    message: 'Registration success. Please login.'
                })
            })
        })

    })
};

/**
 * login : function to login a user 
 * @param {json} req : request object.
 * @param {json} res : response object.
 * @return {json} JSON user data or error message
 */
exports.login = (req, res) => {

    //get email and password
    const {email, password} = req.body;
 
    //find existing user
    User.findOne({email}).exec((err, user) => {
        if (err || !user) {
            return res.status(process.env.APPLICATION_ERROR_CODE).json({
                error: "User with that email doesn't exists. Please register."
            })
        }

        //authenticate the password
        if(!user.authenticate(password)) {
            return res.status(process.env.APPLICATION_ERROR_CODE).json({
                error: "Password isn't match. Please try again."
            })
        }

        //generate token and send to client
        const token = jwt.sign({_id: user._id}, process.env.JWT_SECRET, {expiresIn: '7d'});
        const {_id, name, email, role} = user;

        //return user data
        return res.json({
            token, user: {_id, name, email, role}
        }) 

    } )
};

/**
 * requireSignIn : used by all routes that required login first 
 */
exports.requireSignIn = expressJwt({secret: process.env.JWT_SECRET});

/**
 * authMiddleware : used by all routes that required user data (provides profile attribute)
 * @param {json} req : request object.
 * @param {json} res : response object.
 * @param {function} next : next function
 * @return {json} JSON user data or error message
 */
exports.authMiddleware = (req, res, next) => {

    //get user id
    const authUserId = req.user._id;

    //get user data based on id
    User.findOne({_id: authUserId}).exec((err, user) => {
        if (err || !user) {
            return res.status(process.env.APPLICATION_ERROR_CODE).json({
                error: 'User is not found'
            })
        }

        //put user data in profile attribute
        req.profile = user;

        //call next function
        next();
    })
}

/**
 * adminMiddleware : used by all routes that required admin data (provides profile attribute)
 * @param {json} req : request object.
 * @param {json} res : response object.
 * @param {function} next : next function
 * @return {json} JSON user data or error message
 */
exports.adminMiddleware = (req, res, next) => {
    
    //get user id
    const authAdminId = req.user._id;

    //get user data based on id
    User.findOne({_id: authAdminId}).exec((err, user) => {
        
        //check if user is not exists
        if (err || !user) {
            return res.status(process.env.APPLICATION_ERROR_CODE).json({
                error: 'User is not found'
            })
        }
 
        //check if user is not admin
        if (user.role !== listEnum.user.role.admin) {
            return res.status(process.env.APPLICATION_ERROR_CODE).json({
                error: 'Admin resource. Access is denied.'
            })
        }

        //put user data in profile attribute
        req.profile = user;

        //call next function
        next();
    })
}

/**
 * forgetPassword : create email for forget password 
 * @param {json} req : request object.
 * @param {json} res : response object.
 * @param {function} next : next function
 * @return {json} JSON user data or error message
 */
exports.forgetPassword = (req, res) => {
 
    //get email 
    const {email} = req.body;
 
    //check if user exists with that email
    User.findOne({email}).exec((err, user) => {
        if(err || !user) {
            return res.status(process.env.APPLICATION_ERROR_CODE).json({
                error: 'User with that email does not exists'
            })
        }

        //generate token
        const token = jwt.sign({name: user.name}, process.env.JWT_RESET_PASSWORD, {expiresIn: '60m'})
    
        //create email
        const params = emailForgetPasswordParams(email, token);

        //update DB resetPasswordLink with token
        return user.updateOne({resetPasswordLink: token}, (err, success) => {
            if(err) {
                return res.status(process.env.APPLICATION_ERROR_CODE).json({
                    error: 'Reset password is failed. Try later.'
                })
            }

            //create promise send email
            const sendEmail = ses.sendEmail(params).promise()

            //send email
            sendEmail
            .then(data => {
                return res.json({
                    message: `Email has been sent to ${email}. Click on the link to reset password`
                })
            })
            .catch(error => {
                return res.status(APPLICATION_ERROR_CODE).json({
                    error: `We could not send reset password link to your email. Please try again later`
                })
            })
        })
    })
}

/**
 * resetPassword : update user with new password
 * @param {json} req : request object.
 * @param {json} res : response object.
 * @param {function} next : next function
 * @return {json} JSON user data or error message
 */
exports.resetPassword = (req, res) => {

    //get password link and new password
    const {resetPasswordLink, newPassword} = req.body;
 
    if(resetPasswordLink) {

        //validate token
        jwt.verify(resetPasswordLink, process.env.JWT_RESET_PASSWORD, (err, decodedMsg) => {
            if(err) {
                return res.status(process.env.APPLICATION_ERROR_CODE).json({
                    error: 'Token is expired. Try again later.'
                })
            }
        });

        //check if token is exists
        User.findOne({resetPasswordLink}).exec((err, user) => {
            if(err || !user) {
                return res.status(process.env.APPLICATION_ERROR_CODE).json({
                    error: 'Password reset failed. Try again later.'
                })
            }

            console.log('newPassword: ', newPassword)

            //update new password
            const updatedField = {
                password: newPassword,
                resetPasswordLink: '',
            }
            
            //update user with new password
            user = lodash.extend(user, updatedField );

            //save updated user
            user.save((err, result) => {
                if(err) {
                    return res.status(APPLICATION_ERROR_CODE).json({
                        error: 'Saving your new password is failed. Try again later.'
                    })
                }
 
                //return message
                return res.json({
                    message: 'Reset password is success.'
                })
            })
        })
    }
}