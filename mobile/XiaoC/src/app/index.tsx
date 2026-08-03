import { 
  View, 
  Text, 
  StyleSheet, 
  Pressable,
  TextInput,
} from 'react-native';

import { useEffect, useState, useRef } from 'react';
import { router } from 'expo-router';

import {
  DEFAULT_ACCOUNT_NAME,
  getAccountPassword,
  getAccountSettings,
} from "../lib/accountSettings";


export default function Index() {


  const [password, setPassword] = useState('');
  const [savedPassword, setSavedPassword] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(DEFAULT_ACCOUNT_NAME);
  const [error, setError] = useState('');

  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    let isActive = true;

    Promise.all([
      getAccountSettings(),
      getAccountPassword(),
    ]).then(([account, accountPassword]) => {
      if (!isActive) {
        return;
      }

      setDisplayName(account.displayName);
      setSavedPassword(accountPassword);

      if (!accountPassword) {
        router.replace('/chat');
      }
    });

    return () => {
      isActive = false;
    };
  }, []);



  const handlePress = () => {
    inputRef.current?.focus();
  };



  const handleChange = (text:string) => {

    // 只允许数字
    const value = text.replace(/[^0-9]/g,'');

    setPassword(value);
    setError('');


    if(value.length === 6){

      setTimeout(()=>{

        if(value === savedPassword){

          router.replace('/chat');

          return;

        }

        setPassword('');
        setError('密码不对，再试一次');

      },200);

    }

  };



  return (

    <View style={styles.container}>


      <View style={styles.center}>


        <Text style={styles.logo}>
          🌊
        </Text>


        <Text style={styles.title}>
          小C ♡ {displayName}
        </Text>



        <Pressable
          style={styles.dotsContainer}
          onPress={handlePress}
        >


          {
            Array.from({length:6}).map((_,index)=>(

              <Text
                key={index}
                style={[
                  styles.dot,
                  index < password.length && styles.activeDot
                ]}
              >

                {index < password.length ? '●' : '○'}

              </Text>

            ))
          }


        </Pressable>

        {!!error && (
          <Text style={styles.errorText}>
            {error}
          </Text>
        )}



        <TextInput

          ref={inputRef}

          style={styles.hiddenInput}

          keyboardType="number-pad"

          maxLength={6}

          value={password}

          onChangeText={handleChange}

          autoFocus={false}

        />


      </View>


    </View>

  );
}




const styles = StyleSheet.create({


  container:{
    flex:1,
    backgroundColor:'#FAFAF8',
  },


  center:{
    flex:1,
    justifyContent:'center',
    alignItems:'center',
  },


  logo:{
    fontSize:42,
    marginBottom:24,
  },


  title:{
    fontSize:22,
    color:'#666666',
    fontWeight:'400',
    letterSpacing:1,
    marginBottom:45,
  },


  dotsContainer:{
    flexDirection:'row',
    gap:12,
    padding:20,
  },


  dot:{
    fontSize:25,
    color:'#999999',
  },


  activeDot:{
    color:'#555555',
  },


  errorText:{
    marginTop:12,
    fontSize:14,
    color:'#B26A6A',
  },


  hiddenInput:{
    position:'absolute',
    width:1,
    height:1,
    opacity:0,
  },


});
