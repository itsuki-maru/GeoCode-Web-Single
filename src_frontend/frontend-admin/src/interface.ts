interface LoginUser {
  username?: string;
  isAuthenticated: boolean;
}

interface UserData {
  id: string;
  username: string;
  password: string;
  create_at: string;
  is_superuser: boolean;
  is_locked: boolean;
}

interface LockedUserData {
  id: string;
  username: string;
  is_locked: boolean;
}

interface UpdateUserData {
  id: string;
  username: string;
  new_password: string;
  is_superuser: boolean;
}

// アプリケーションの起動時情報
interface ApplicationInit {
  appTitle: string;
  allowUserAccountCreate: boolean;
  allowOrigins: string; // ex) http://localhost:3000,www.example.com
}

export type { LoginUser, UserData, UpdateUserData, LockedUserData, ApplicationInit };
