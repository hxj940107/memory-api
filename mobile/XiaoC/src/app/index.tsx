import { 
  View, 
  Text, 
  StyleSheet, 
  Pressable,
  TextInput,
  Animated,
  Keyboard,
} from 'react-native';

import { useEffect, useState, useRef } from 'react';
import { router } from 'expo-router';
import { Image } from 'expo-image';

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
  const [isWelcoming, setIsWelcoming] = useState(false);

  const inputRef = useRef<TextInput>(null);
  const passcodeOpacity = useRef(new Animated.Value(1)).current;
  const welcomeCOpacity = useRef(new Animated.Value(0)).current;
  const welcomeCTranslate = useRef(new Animated.Value(8)).current;
  const welcomeTextOpacity = useRef(new Animated.Value(0)).current;
  const welcomeTextTranslate = useRef(new Animated.Value(8)).current;

  const XiaoCMark = () => (
    <Image
      source={require("../../assets/xiaoc-crescent.svg")}
      style={styles.crescentMark}
      contentFit="contain"
    />
  );

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

          setIsWelcoming(true);
          setError('');

          Animated.sequence([
            Animated.timing(passcodeOpacity, {
              toValue: 0,
              duration: 260,
              useNativeDriver: true,
            }),
            Animated.parallel([
              Animated.timing(welcomeCOpacity, {
                toValue: 1,
                duration: 520,
                useNativeDriver: true,
              }),
              Animated.timing(welcomeCTranslate, {
                toValue: 0,
                duration: 520,
                useNativeDriver: true,
              }),
            ]),
            Animated.parallel([
              Animated.timing(welcomeTextOpacity, {
                toValue: 1,
                duration: 420,
                useNativeDriver: true,
              }),
              Animated.timing(welcomeTextTranslate, {
                toValue: 0,
                duration: 420,
                useNativeDriver: true,
              }),
            ]),
            Animated.delay(620),
          ]).start(() => {
            router.replace('/chat');
          });

          return;

        }

        setPassword('');
        setError('密码不对，再试一次');

      },200);

    }

  };



  return (

    <Pressable
      style={styles.container}
      onPress={Keyboard.dismiss}
    >


      <View style={styles.center}>

        <Animated.View
          pointerEvents={isWelcoming ? 'none' : 'auto'}
          style={[
            styles.passcodeContent,
            {
              opacity: passcodeOpacity,
            },
          ]}
        >

            <View style={styles.logo}>
              <XiaoCMark />
            </View>


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

            <Text style={styles.hint}>
              输入密码
            </Text>

        </Animated.View>

        {isWelcoming && (
          <View
            pointerEvents="none"
            style={styles.welcomeContent}
          >
            <Animated.View
              style={[
                styles.welcomeLogo,
                {
                  opacity: welcomeCOpacity,
                  transform: [{ translateY: welcomeCTranslate }],
                },
              ]}
            >
              <XiaoCMark />
            </Animated.View>

            <Animated.View
              style={[
                styles.welcomeTextGroup,
                {
                  opacity: welcomeTextOpacity,
                  transform: [{ translateY: welcomeTextTranslate }],
                },
              ]}
            >
              <Text style={styles.welcomeText}>
                欢迎回来
              </Text>
              <Text style={styles.welcomeName}>
                {displayName}
              </Text>
            </Animated.View>
          </View>
        )}

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

          autoFocus={!isWelcoming}

          editable={!isWelcoming}

        />


      </View>


    </Pressable>

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

  passcodeContent:{
    alignItems:'center',
    justifyContent:'center',
    transform:[{ translateY:-28 }],
  },

  logo:{
    marginBottom:96,
  },

  crescentMark:{
    width:44,
    height:44,
  },

  hint:{
    marginTop:18,
    fontSize:13,
    color:'#B2AAA5',
    fontWeight:'400',
    letterSpacing:2,
  },


  dotsContainer:{
    flexDirection:'row',
    gap:12,
    paddingHorizontal:20,
    paddingVertical:12,
  },


  dot:{
    fontSize:31,
    lineHeight:34,
    color:'#A8A8A8',
    fontWeight:'200',
  },


  activeDot:{
    color:'#6A6F6D',
  },


  errorText:{
    marginTop:12,
    fontSize:14,
    color:'#B26A6A',
  },

  welcomeContent:{
    position:'absolute',
    alignItems:'center',
    justifyContent:'center',
    transform:[{ translateY:-12 }],
  },


  welcomeLogo:{
    marginBottom:34,
  },


  welcomeTextGroup:{
    alignItems:'center',
  },


  welcomeText:{
    fontSize:15,
    lineHeight:25,
    color:'#9B9692',
    fontWeight:'300',
    letterSpacing:2,
    textAlign:'center',
  },


  welcomeName:{
    marginTop:2,
    fontSize:15,
    lineHeight:25,
    color:'#87827E',
    fontWeight:'300',
    letterSpacing:3,
    textAlign:'center',
  },


  hiddenInput:{
    position:'absolute',
    width:1,
    height:1,
    opacity:0,
  },


});
