const _ = require('underscore')

const insertActivityWalkArray = async (req_body, authUser) => {
  console.log(req_body)
  let must_update_stats = false;

  if (!authUser || (String(authUser._id) != String(req_body.user_id) && !authUser.admin && !authUser.global_admin)) {
    throw new Error('not authorized');
  }

  let stepsArray = req_body.stats;
  const user_id = new ObjectId(req_body.user_id);

  // normalize step array
  if (
    stepsArray
    && stepsArray.length == 1
    && stepsArray[0].start_time
    && stepsArray[0].start_time.constructor == Array
  ) {
    const list = stepsArray[0];
    stepsArray = _.map(list.start_time, (_start_time, index) => ({
      start_time: list.start_time[index],
      steps: list.steps[index],
    }));
  }

  stepsArray = _.map(stepsArray, (steps) => {
    steps.device_id = steps.device_id || req_body.device_id;
    return steps;
  });

  // if more than 1 day exists in array delete duplicate
  const stepsArrayClean = [];
  for (const steps of stepsArray) {
    steps.start_day = moment(steps.start_time)
      .local()
      .startOf('day')
      .toDate();
    steps.end_day = moment(steps.start_time)
      .local()
      .endOf('day')
      .toDate();
    const stepsExists = _.find(stepsArrayClean, (stepsClean) => steps.start_time == stepsClean.start_time);
    if (stepsExists) {
      if (stepsExists.steps < steps.steps) {
        stepsArrayClean.push(steps);
      }
    } else {
      stepsArrayClean.push(steps);
    }
  }

  // console.log(stepsArrayClean)

  if (stepsArrayClean.length == 0) {
    throw new Error('noSyncNeeded');
  }

  let start_date_min = _.min(stepsArrayClean, (result) => result.start_day);
  let end_date_max = _.max(stepsArrayClean, (result) => result.end_day);

  start_date_min = start_date_min ? start_date_min.start_day : new Date();
  end_date_max = end_date_max ? end_date_max.start_day : new Date();

  const stepsArrayClean2 = [];
  const stepsSource = await runOptimizedModel
    .find({
      user_id,
      activity_type: 'walking',
      start_time: {
        $gte: start_date_min,
        $lte: end_date_max,
      },
    })
    .select('start_time steps points has_cheated device_id profiles')
    .exec();

  for (const stepsClean of stepsArrayClean) {
    const nb_steps = parseInt(stepsClean.steps);

    const nb_steps_source = _.find(stepsSource, (stepSource) => moment(stepSource.start_time).diff(stepsClean.start_day, 'days') == 0);

    // Don't overide steps if less new steps
    if (
      nb_steps_source
      && nb_steps_source.steps
      && (nb_steps_source.steps >= nb_steps || nb_steps_source.device_id == 'admin')
    ) {
      continue;
    }

    // console.log("nb_steps_source", run.points, nb_steps_source.points, run.steps, nb_steps_source.steps)
    if (!nb_steps_source || nb_steps > nb_steps_source.steps) {
      stepsClean.has_cheated = nb_steps_source ? (!!nb_steps_source.has_cheated) : false;
      const source_points = _.reduce(
        nb_steps_source ? nb_steps_source.profiles : [],
        (memo, profile) => memo + profile.points,
        0,
      );
      stepsClean.source_points = source_points;
      stepsClean.nb_steps = nb_steps;
      stepsArrayClean2.push(stepsClean);
    }
  }

  // console.log(stepsArrayClean2)

  if (stepsArrayClean2.length == 0) {
    throw new Error('noSyncNeeded');
  }

  const user = await checkUser(user_id);

  const companyMainProfile = user.profile.company && '_id' in user.profile.company ? user.profile.company : null;
  const userBoosts = await boostLogic.getBoostsUserInterval(
    user_id,
    companyMainProfile._id,
    start_date_min,
    end_date_max,
  );

  const nb_max_boosts = companyMainProfile && companyMainProfile.options && companyMainProfile.options.boost_mode == 2 ? 3 : 5;

  for (const result of stepsArrayClean2) {
    let pointsAchieved = 0;

    const nb_boosts_array = _.filter(
      userBoosts,
      (userBoost) => moment(userBoost.start_date).diff(moment(result.start_day), 'days') == 0,
    );
    let nb_boosts = _.reduce(nb_boosts_array, (memo, boost) => memo + boost.nb_boosts, 0);
    nb_boosts = nb_boosts > nb_max_boosts ? nb_max_boosts : nb_boosts;

    let boost_value = nb_boosts * 10;

    if (companyMainProfile && companyMainProfile.code == 'gosafran') {
      boost_value = nb_boosts * 12;
    }

    const run = {};
    const company = user.profile ? user.profile.company : null;
    const squad_id = user.profile
      ? user.profile.squad && '_id' in user.profile.squad
        ? (user.profile.squad)._id
        : user.profile.squad
      : null;

    run.activity_type = 'walking';
    run.user_id = user_id;
    run.squad_id = squad_id;
    run.company_id = company ? company._id : null;
    run.duration = 24 * 60 * 60;
    run.start_time = result.start_day;
    run.end_time = result.end_day;
    run.has_cheated = result.has_cheated;
    run.steps = result.nb_steps > 100000 ? 100000 : result.nb_steps;
    run.device_id = result.device_id;
    run.achievements = [];
    run.is_suspicious = result.nb_steps > 25000;
    const inserted_time = moment(result.start_time).toDate();
    if (utils.isDate(inserted_time)) {
      run.inserted_time = inserted_time;
    }

    run.updated_time = new Date();

    run.type = req_body.type || 'run';
    run.source = 'type' in req_body ? req_body.type : 'tracker';

    const points_run = company && company.start_challenge >= result.start_day
      ? 0
      : formula(0, 0, 0, result.nb_steps, run.activity_type, company);
    run.points_run = run.has_cheated == true ? 0 : points_run;
    // boosted

    if (nb_boosts > 0) {
      const points_boosted = Math.floor((points_run * boost_value) / 10000) * 100;
      run.achievements.push({
        code: 'boost',
        title: getTranslations('ach.boost', user.language, {
          nb_boosts,
          boost_value,
        }),
        points: points_boosted,
      });
      pointsAchieved += points_boosted;
    }

    run.nb_boosts = nb_boosts;
    run.boost_value = boost_value;
    run.points = run.has_cheated == true ? 0 : points_run + pointsAchieved;

    run.profiles = [];

    for (const profile of user.profiles) {
      const { challenge } = profile;
      const challenge_id = profile.challenge && '_id' in profile.challenge
        ? (profile.challenge)._id
        : profile.challenge;
      const squad_id = profile.squad && '_id' in profile.squad ? (profile.squad)._id : profile.squad;

      if (squad_id && challenge_id) {
        const runProfile = {
          squad: squad_id,
          challenge: challenge_id,
        };

        let points_run = challenge.start_challenge > result.start_day
          ? 0
          : formula(0, 0, 0, result.nb_steps, run.activity_type, challenge);

        if (profile && profile.blocked === true) {
          points_run = 0;
        }
        runProfile.points_run = run.has_cheated == true ? 0 : points_run;
        // boosted
        let pointsAchieved = 0;

        if (nb_boosts > 0) {
          const points_boosted = Math.floor((points_run * boost_value) / 10000) * 100;
          if (!runProfile.achievements) {
            runProfile.achievements = [];
          }
          runProfile.achievements.push({
            code: 'boost',
            title: getTranslations('ach.boost', user.language, {
              nb_boosts,
              boost_value,
            }),
            points: points_boosted,
          });
          pointsAchieved += points_boosted;
        }

        runProfile.nb_boosts = nb_boosts;
        runProfile.boost_value = boost_value;
        runProfile.points = run.has_cheated == true ? 0 : points_run + pointsAchieved;

        run.profiles.push(runProfile);
      }
    }

    const runSaved = await runModel
      .findOneAndUpdate(
        {
          user_id,
          activity_type: 'walking',
          start_time: { $lte: result.end_day, $gte: result.start_day },
        },
        { $set: run },
        { new: true, upsert: true },
      )
      .exec();
    optimizeRun(runSaved);
  }
};


insertActivityWalkArray([], {})