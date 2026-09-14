
import { IsNotEmpty, IsString } from "class-validator";
import { Users } from "src/domain/entities/Users";
import { recordStatus } from "src/domain/enums/recordstatus.enum";


// jwt-payload.dto.ts
export class JwtPayload {   
  userid: string;
    username:string;
    role: string[];
    email: string;
    name: string;
    surname:string;
    phone:string;
    emailConfirmed:boolean;
    phoneConfirmed:boolean;
    isVerified:boolean;
    imageSrc:string;
    isActive: boolean;
    profileStep:number;
    subscription:string;
    constructor(user: Users) {
      this.userid = user.id;
      this.username = user.username;
      /* this.email = user.email;
      this.name = user.name;
      this.surname=user.surname;
      this.phone=user.phone; */
     /*  this.emailConfirmed=user.emailConfirm??false;
      this.phoneConfirmed=user.phoneConfirm??false;
      this.isVerified=user.isVerified;
      this.imageSrc=user.imageSrc;
      this.subscription=user.subscription; */
      this.isActive=user.recordStatus==recordStatus.Active?true:false;
     /*  if (user.name == null ) {
        this.profileStep = 1;
      } else if (user.surname == null ) {
        this.profileStep = 2;
      } else if (user.birthdate == null) {
        this.profileStep = 3;
      }else{
        this.profileStep = 0;
      } */
    }
  }
  
  export class userLoginResultDto{
    isAuthenticate:boolean;    
    access_token:string;
    message:string;
    user:Users;
    
  }